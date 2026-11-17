#!/usr/bin/env python3
"""Встроенный SMB2/SMB3-клиент для сетевого диска с фото (без монтирования на хосте Linux).
Вызывается из server/services/photoStorage.ts через JSON по stdin/stdout.
Поддерживает: probe (с автоподбором регистра/написания общей папки через srvsvc IPC$),
write, read_first, delete, put_file, scan, usage, sample, normalize_date_dirs, list_folders, walk_images, move_many.
"""
from __future__ import annotations

import base64
import datetime as dt
import errno
import json
import os
import re
import shutil
import stat as stat_mod
import struct
import sys
import unicodedata
import uuid
from typing import Any, Optional

_CONNECT_TIMEOUT = 10
IMAGE_EXTS = frozenset({"jpg", "jpeg", "jpe", "jfif", "png", "gif", "webp", "bmp", "heic", "heif", "tif", "tiff"})
SKIP_DIRS = frozenset({"@eadir", "#recycle", "$recycle.bin", "__macosx", "thumbs", ".thumbnails", "system volume information"})

_LOOKALIKE = str.maketrans("abcehkmoptxy", "авсенкмортху")
_ALNUM_RE = re.compile(r"[^\W_]+")
_ARENA_LATIN = "аrеnа"
_ARENA_SM_RE = re.compile(r"(арена)[\W_]*[сs]м(?=[\W_\d]|$)")
_ISO_DIR = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def fold_name(text: object) -> str:
    s = unicodedata.normalize("NFC", str(text or "")).casefold().replace("ё", "е").translate(_LOOKALIKE).replace(_ARENA_LATIN, "арена")
    return _ARENA_SM_RE.sub(r"\1", s)


def compact_name(text: object) -> str:
    return "".join(_ALNUM_RE.findall(fold_name(text)))


def date_dir(iso: object) -> str:
    m = _ISO_DIR.match(str(iso or ""))
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else str(iso or "")


def _iso_dirs_to_rename(names: list[str]) -> list[tuple[str, str]]:
    return [(n, date_dir(n)) for n in names if _ISO_DIR.match(n)]


def _unique_rel(exists, rel: str) -> str:
    if not exists(rel):
        return rel
    head, _, name = rel.rpartition("/")
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    for n in range(2, 1000):
        cand = f"{head + '/' if head else ''}{stem} ({n}){'.' + ext if ext else ''}"
        if not exists(cand):
            return cand
    raise OSError("не подобрать свободное имя файла")


# ------------------------------------------------------------------ srvsvc (список общих папок сервера)
_SRVSVC = uuid.UUID("4b324fc8-1670-01d3-1278-5a47bf6ee188")
_NDR32 = uuid.UUID("8a885d04-1ceb-11c9-9fe8-08002b104860")
_OP_NET_SHARE_ENUM = 15
_MAX_FRAG = 4280


def _bind_pdu(call_id: int) -> bytes:
    ctx = struct.pack("<HBB", 0, 1, 0) + _SRVSVC.bytes_le + struct.pack("<HH", 3, 0) + _NDR32.bytes_le + struct.pack("<I", 2)
    body = struct.pack("<HHIBxxx", _MAX_FRAG, _MAX_FRAG, 0, 1) + ctx
    head = struct.pack("<BBBB4sHHI", 5, 0, 11, 0x03, b"\x10\x00\x00\x00", 16 + len(body), 0, call_id)
    return head + body


def _request_pdu(call_id: int, opnum: int, stub: bytes) -> bytes:
    body = struct.pack("<IHH", len(stub), 0, opnum) + stub
    head = struct.pack("<BBBB4sHHI", 5, 0, 0, 0x03, b"\x10\x00\x00\x00", 16 + len(body), 0, call_id)
    return head + body


def _share_enum_stub() -> bytes:
    return struct.pack("<IIIIIII", 0, 1, 1, 0x00020000, 0, 0, 0xFFFFFFFF) + struct.pack("<I", 0)


def _read_pdu(pipe) -> tuple[int, int, bytes]:
    data = b""
    while len(data) < 16:
        chunk = pipe.read(65536)
        if not chunk:
            raise OSError("канал srvsvc закрылся")
        data += chunk
    frag_len = struct.unpack_from("<H", data, 8)[0]
    while len(data) < frag_len:
        chunk = pipe.read(65536)
        if not chunk:
            raise OSError("канал srvsvc закрылся")
        data += chunk
    return data[2], data[3], data[:frag_len]


def _parse_enum(stub: bytes) -> list[dict[str, Any]]:
    pos = 0

    def u32() -> int:
        nonlocal pos
        pos = (pos + 3) & ~3
        val = struct.unpack_from("<I", stub, pos)[0]
        pos += 4
        return val

    def string() -> str:
        nonlocal pos
        u32()
        u32()
        count = u32()
        raw = stub[pos:pos + count * 2]
        pos += count * 2
        return raw.decode("utf-16-le").rstrip("\x00")

    u32()
    u32()
    if u32() == 0:
        return []
    count = u32()
    if u32() == 0:
        return []
    u32()
    items = []
    for _ in range(count):
        name_ptr, kind, remark_ptr = u32(), u32(), u32()
        items.append([name_ptr, kind, remark_ptr])
    out: list[dict[str, Any]] = []
    for name_ptr, kind, remark_ptr in items:
        name = string() if name_ptr else ""
        remark = string() if remark_ptr else ""
        out.append({"name": name, "type": kind, "remark": remark})
    return out


def list_shares(server: str, smb, **kw) -> list[str]:
    pipe = smb.open_file(f"\\\\{server}\\IPC$\\srvsvc", mode="r+b", buffering=0, file_type="pipe", **kw)
    try:
        pipe.write(_bind_pdu(1))
        ptype, _flags, pdu = _read_pdu(pipe)
        if ptype != 12:
            raise OSError("сервер не принял запрос списка общих папок")
        sec_len = struct.unpack_from("<H", pdu, 24)[0]
        pos = (26 + sec_len + 3) & ~3
        if struct.unpack_from("<H", pdu, pos + 4)[0] != 0:
            raise OSError("сервер не поддерживает запрос списка общих папок")
        pipe.write(_request_pdu(2, _OP_NET_SHARE_ENUM, _share_enum_stub()))
        stub = b""
        while True:
            ptype, flags, pdu = _read_pdu(pipe)
            if ptype == 3:
                raise OSError("сервер отказал в списке общих папок")
            if ptype != 2:
                raise OSError("неожиданный ответ сервера")
            stub += pdu[24:]
            if flags & 0x02:
                break
        shares = _parse_enum(stub)
    finally:
        try:
            pipe.close()
        except Exception:
            pass
    names = []
    for s in shares:
        if (s["type"] & 0xFF) != 0 or (s["type"] & 0x80000000) or s["name"].endswith("$"):
            continue
        names.append(s["name"])
    return names


# ------------------------------------------------------------------ SMB-клиент
def _smb():
    try:
        import smbclient
    except ImportError as exc:
        raise OSError("не установлена библиотека SMB (smbprotocol)") from exc
    return smbclient


def _is_missing(exc: BaseException) -> bool:
    if isinstance(exc, FileNotFoundError):
        return True
    text = str(exc)
    return (isinstance(exc, OSError) and exc.errno == errno.ENOENT) or "OBJECT_NAME_NOT_FOUND" in text or "OBJECT_PATH_NOT_FOUND" in text


_NT_LOGON = {0xC000006D, 0xC000006A, 0xC0000064, 0xC000006E, 0xC0000070, 0xC0000071, 0xC0000072, 0xC0000234, 0xC000015B}
_NT_SHARE = {0xC00000CC, 0xC00000BE}
_NT_DENIED = {0xC0000022}


def explain_smb_error(exc: BaseException, server: str = "", share: str = "") -> str:
    name, text = type(exc).__name__, str(exc)
    upper = text.upper()
    code = getattr(exc, "ntstatus", None)
    if code is None:
        code = getattr(exc, "status", None)
    if code in _NT_LOGON or "LOGON_FAILURE" in upper or "AUTHENTICATION" in name.upper() or "WRONG_PASSWORD" in upper:
        return "неверный логин или пароль (или учётная запись заблокирована)"
    if "GUEST" in upper:
        return "сервер не принял этот логин или пароль (вход получился только гостем) — проверьте логин и пароль"
    if code in _NT_SHARE or "BAD_NETWORK_NAME" in upper or "BADNETWORKNAME" in name.upper():
        return f"общая папка «{share}» не найдена на сервере — проверьте её имя"
    if code in _NT_DENIED or "ACCESS_DENIED" in upper or isinstance(exc, PermissionError):
        return "нет прав: у этого пользователя нет доступа к папке или записи в неё"
    if _is_missing(exc):
        return "папка не найдена на диске — создайте её или поправьте путь"
    if "GETADDRINFO" in upper or "FAILED TO CONNECT" in upper or isinstance(exc, (ConnectionError, TimeoutError)) or "TIMED OUT" in upper or "UNREACHABLE" in upper or "REFUSED" in upper:
        hint = ""
        if server and not re.fullmatch(r"[\d.:]+", server):
            hint = ". Указано имя компьютера — попробуйте вместо него IP-адрес (например \\\\192.168.1.10\\папка): сервер приложения может не знать это имя"
        return f"сервер {server or ''} недоступен — проверьте имя или IP и сеть{hint}"
    if "SOCKET WAS CLOSED" in upper or "CONNECTIONCLOSED" in name.upper():
        return "связь с сервером оборвалась"
    if "NO SPACE" in upper or "DISK_FULL" in upper or "QUOTA" in upper:
        return "на сетевом диске нет места"
    return f"{name}: {text[:200]}"


def _smb_exists(smb, path: str, kw: dict) -> bool:
    try:
        smb.stat(path, **kw)
        return True
    except Exception as exc:
        if _is_missing(exc):
            return False
        raise


def _smb_rmtree_empty(smb, path: str, kw: dict) -> None:
    try:
        for e in smb.scandir(path, **kw):
            if e.is_dir():
                _smb_rmtree_empty(smb, path + "\\" + e.name, kw)
        smb.rmdir(path, **kw)
    except Exception:
        pass


def _to_ts(value: Any) -> float:
    if isinstance(value, dt.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=dt.timezone.utc)
        return value.timestamp()
    return float(value or 0)


class SmbBackend:
    def __init__(self, cfg: dict[str, Any], isolated: bool = False):
        self._cache: Optional[dict] = {} if isolated else None
        self.server = str(cfg.get("server") or "").strip()
        self.share = str(cfg.get("share") or "").strip()
        self.folder = "/".join(p for p in str(cfg.get("folder") or "").replace("\\", "/").split("/") if p)
        self.port = int(cfg.get("port") or 445)
        self.domain = str(cfg.get("domain") or "").strip()
        self.username = str(cfg.get("username") or "").strip()
        self.password = str(cfg.get("password") or "")
        self.share_names: list[str] = []
        self.share_fixed = False

    def target(self) -> str:
        return "\\\\" + self.server + "\\" + self.share + ("\\" + self.folder.replace("/", "\\") if self.folder else "")

    def _kw(self) -> dict[str, Any]:
        user = f"{self.domain}\\{self.username}" if self.domain and self.username else self.username
        kw: dict[str, Any] = {
            "username": user or None,
            "password": self.password if user else None,
            "port": self.port,
            "connection_timeout": _CONNECT_TIMEOUT,
        }
        if self._cache is not None:
            kw["connection_cache"] = self._cache
        return kw

    def close(self) -> None:
        if self._cache is not None:
            try:
                _smb().reset_connection_cache(connection_cache=self._cache)
            except Exception:
                pass

    def _unc(self, rel: str = "") -> str:
        parts = ["\\\\" + self.server, self.share]
        if self.folder:
            parts.append(self.folder.replace("/", "\\"))
        if rel:
            parts.append(rel.replace("/", "\\"))
        return "\\".join(parts)

    def _find_share(self, smb, kw) -> Optional[str]:
        try:
            names = list_shares(self.server, smb, **kw)
        except Exception:
            names = []
        self.share_names = names
        same = [n for n in names if compact_name(n) == compact_name(self.share)]
        return same[0] if len(same) == 1 else None

    def _share_missing_text(self) -> str:
        text = f"общая папка «{self.share}» не найдена на сервере"
        if self.share_names:
            shown = ", ".join(f"«{n}»" for n in self.share_names[:12])
            return f"{text}. Сервер показывает этому пользователю: {shown}. Впишите одну из них (если нужной тут нет — у пользователя нет к ней доступа)"
        return f"{text} — проверьте её имя (и что у этого пользователя есть к ней доступ)"

    def probe(self) -> tuple[bool, str]:
        try:
            smb = _smb()
            kw = self._kw()
            try:
                smb.stat("\\\\" + self.server + "\\" + self.share, **kw)
            except Exception as exc:
                if not (_is_missing(exc) or getattr(exc, "ntstatus", None) in _NT_SHARE):
                    raise
                fixed = self._find_share(smb, kw)
                if fixed is None:
                    return False, self._share_missing_text()
                self.share, self.share_fixed = fixed, True
                smb.stat("\\\\" + self.server + "\\" + self.share, **kw)
            base = self._unc()
            if not stat_mod.S_ISDIR(smb.stat(base, **kw).st_mode):
                return False, "указанный путь — не папка"
            test = base + f"\\.write-test-{os.getpid()}"
            with smb.open_file(test, mode="wb", **kw) as f:
                f.write(b"1")
            smb.remove(test, **kw)
            return True, ""
        except Exception as exc:
            return False, explain_smb_error(exc, self.server, self.share)

    def write(self, rel: str, content: bytes) -> None:
        smb, kw = _smb(), self._kw()
        final = self._unc(rel)
        smb.makedirs(final.rsplit("\\", 1)[0], exist_ok=True, **kw)
        part = final + ".part"
        with smb.open_file(part, mode="wb", **kw) as f:
            f.write(content)
        smb.replace(part, final, **kw)

    def read_first(self, rels: list[str]) -> Optional[bytes]:
        smb, kw = _smb(), self._kw()
        for rel in rels:
            try:
                with smb.open_file(self._unc(rel), mode="rb", **kw) as f:
                    return f.read()
            except Exception as exc:
                if _is_missing(exc):
                    continue
                raise
        return None

    def delete(self, rels: list[str]) -> int:
        smb, kw = _smb(), self._kw()
        n = 0
        for rel in rels:
            try:
                smb.remove(self._unc(rel), **kw)
                n += 1
            except Exception as exc:
                if not _is_missing(exc):
                    raise
        return n

    def put_file(self, src_path: str, rel: str) -> None:
        smb, kw = _smb(), self._kw()
        size = os.stat(src_path).st_size
        final = self._unc(rel)
        try:
            if smb.stat(final, **kw).st_size == size:
                return
        except Exception as exc:
            if not _is_missing(exc):
                raise
        smb.makedirs(final.rsplit("\\", 1)[0], exist_ok=True, **kw)
        part = final + ".part"
        with open(src_path, "rb") as fin, smb.open_file(part, mode="wb", **kw) as fout:
            shutil.copyfileobj(fin, fout, 1024 * 1024)
        if smb.stat(part, **kw).st_size != size:
            smb.remove(part, **kw)
            raise OSError(f"размер после копирования не совпал: {os.path.basename(src_path)}")
        smb.replace(part, final, **kw)

    def scan(self) -> dict[str, int]:
        smb, kw = _smb(), self._kw()
        files = size = 0
        stack = [self._unc()]
        while stack:
            cur = stack.pop()
            for entry in smb.scandir(cur, **kw):
                if entry.name.startswith(".") or entry.name.endswith(".part"):
                    continue
                if entry.is_dir():
                    stack.append(cur + "\\" + entry.name)
                else:
                    files += 1
                    info = getattr(entry, "smb_info", None)
                    if info is not None:
                        size += int(info.end_of_file)
                    else:
                        size += smb.stat(cur + "\\" + entry.name, **kw).st_size
        return {"files": files, "bytes": size}

    def usage(self) -> Optional[dict[str, int]]:
        try:
            v = _smb().stat_volume("\\\\" + self.server + "\\" + self.share, **self._kw())
            return {"total": int(v.total_size), "free": int(v.caller_available_size)}
        except Exception:
            return None

    def sample(self) -> dict[str, Any]:
        smb, kw = _smb(), self._kw()
        names = sorted(e.name for e in smb.scandir(self._unc(), **kw) if e.is_dir() and not e.name.startswith("."))
        return {"folders": len(names), "names": names[:8]}

    def normalize_date_dirs(self, top: str) -> list[list[str]]:
        smb, kw = _smb(), self._kw()
        base = self._unc(top)
        try:
            names = [e.name for e in smb.scandir(base, **kw) if e.is_dir()]
        except Exception as exc:
            if _is_missing(exc):
                return []
            raise
        done: list[list[str]] = []
        for old, new in _iso_dirs_to_rename(names):
            src, dst = base + "\\" + old, base + "\\" + new
            try:
                try:
                    smb.stat(dst, **kw)
                    exists = True
                except Exception as exc:
                    if not _is_missing(exc):
                        raise
                    exists = False
                if not exists:
                    smb.rename(src, dst, **kw)
                else:
                    stack = [(src, "")]
                    while stack:
                        cur, prefix = stack.pop()
                        for e in smb.scandir(cur, **kw):
                            if e.is_dir():
                                stack.append((cur + "\\" + e.name, prefix + e.name + "/"))
                                continue
                            rel_in = prefix + e.name
                            target = _unique_rel(lambda r: _smb_exists(smb, dst + "\\" + r.replace("/", "\\"), kw), rel_in)
                            smb.makedirs((dst + "\\" + target.replace("/", "\\")).rsplit("\\", 1)[0], exist_ok=True, **kw)
                            smb.rename(cur + "\\" + e.name, dst + "\\" + target.replace("/", "\\"), **kw)
                    _smb_rmtree_empty(smb, src, kw)
                done.append([f"{top}/{old}", f"{top}/{new}"])
            except Exception:
                pass
        return done

    def list_folders(self) -> list[str]:
        smb, kw = _smb(), self._kw()
        return sorted(
            e.name
            for e in smb.scandir(self._unc(), **kw)
            if e.is_dir() and not e.name.startswith(".") and e.name.casefold() not in SKIP_DIRS
        )

    def walk_images(self, top: str) -> list[list[Any]]:
        smb, kw = _smb(), self._kw()
        out: list[list[Any]] = []
        stack = [(self._unc(top), top, 0)]
        while stack:
            path, rel, depth = stack.pop()
            for e in smb.scandir(path, **kw):
                name = e.name
                if name.startswith("."):
                    continue
                if e.is_dir():
                    if depth < 10 and name.casefold() not in SKIP_DIRS:
                        stack.append((path + "\\" + name, rel + "/" + name, depth + 1))
                    continue
                if "." not in name or name.rsplit(".", 1)[-1].casefold() not in IMAGE_EXTS:
                    continue
                info = getattr(e, "smb_info", None)
                if info is not None:
                    size, mtime = int(info.end_of_file), _to_ts(info.last_write_time)
                else:
                    st = e.stat()
                    size, mtime = st.st_size, st.st_mtime
                out.append([rel + "/" + name, size, mtime])
        return out

    def move_many(self, pairs: list[list[str]]) -> list[list[Optional[str]]]:
        smb, kw = _smb(), self._kw()

        def exists(rel: str) -> bool:
            try:
                smb.stat(self._unc(rel), **kw)
                return True
            except Exception as exc:
                if _is_missing(exc):
                    return False
                raise

        out: list[list[Optional[str]]] = []
        for src, dst in pairs:
            try:
                target = _unique_rel(exists, dst)
                smb.makedirs(self._unc(target).rsplit("\\", 1)[0], exist_ok=True, **kw)
                smb.rename(self._unc(src), self._unc(target), **kw)
                out.append([target, None])
            except Exception as exc:
                out.append([dst, explain_smb_error(exc, self.server, self.share)])
        return out


def main() -> None:
    raw = sys.stdin.read()
    req = json.loads(raw)
    op = req.get("op")
    cfg = req.get("cfg") or {}
    isolated = bool(req.get("isolated", False))
    be = SmbBackend(cfg, isolated=isolated)
    try:
        if op == "probe":
            ok, reason = be.probe()
            res: dict[str, Any] = {
                "ok": ok,
                "message": reason,
                "target": be.target(),
                "server": be.server,
                "share": be.share,
                "folder": be.folder,
                "shares": be.share_names,
                "share_fixed": be.share_fixed,
            }
            if ok and req.get("with_sample"):
                try:
                    res.update(be.sample())
                except Exception:
                    pass
                try:
                    res["disk"] = be.usage()
                except Exception:
                    res["disk"] = None
            print(json.dumps({"ok": True, "result": res}, ensure_ascii=False))
        elif op == "usage":
            print(json.dumps({"ok": True, "result": be.usage()}, ensure_ascii=False))
        elif op == "scan":
            print(json.dumps({"ok": True, "result": be.scan()}, ensure_ascii=False))
        elif op == "write":
            data = base64.b64decode(req["content_b64"])
            be.write(req["rel"], data)
            print(json.dumps({"ok": True, "result": True}))
        elif op == "put_file":
            be.put_file(req["src_path"], req["rel"])
            print(json.dumps({"ok": True, "result": True}))
        elif op == "read_first":
            data = be.read_first(req["rels"])
            b64 = base64.b64encode(data).decode("ascii") if data is not None else None
            print(json.dumps({"ok": True, "result": b64}))
        elif op == "delete":
            n = be.delete(req["rels"])
            print(json.dumps({"ok": True, "result": n}))
        elif op == "list_folders":
            print(json.dumps({"ok": True, "result": be.list_folders()}, ensure_ascii=False))
        elif op == "normalize_date_dirs":
            print(json.dumps({"ok": True, "result": be.normalize_date_dirs(req["top"])}, ensure_ascii=False))
        elif op == "walk_images":
            print(json.dumps({"ok": True, "result": be.walk_images(req["top"])}, ensure_ascii=False))
        elif op == "move_many":
            print(json.dumps({"ok": True, "result": be.move_many(req["pairs"])}, ensure_ascii=False))
        else:
            print(json.dumps({"ok": False, "error": f"Unknown op: {op}"}))
    except Exception as exc:
        err_msg = explain_smb_error(exc, be.server, be.share)
        print(json.dumps({"ok": False, "error": err_msg, "missing": _is_missing(exc)}, ensure_ascii=False))
    finally:
        be.close()


if __name__ == "__main__":
    main()
