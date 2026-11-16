"""Робот Яндекс.Конструктора карт — отдельный сервис (контейнер yandex-robot).

Держит постоянные браузеры (Chromium без окна) с профилями на диске: вход в Яндекс
делается один раз — через окно в веб-интерфейсе календаря (скриншоты браузера и
передача кликов/клавиш, см. /view*) — и сохраняется в профиле. Пароль в календарь и в
базу не попадает: он уходит только в сам браузер, на страницу Яндекса.

Профилей два (параметр profile): «maps» — аккаунт для Конструктора карт, «forms» — аккаунт СОЗДАТЕЛЯ Яндекс Форм (файлы-вложения
ответов и таблицу ответов Яндекс отдаёт только ему). Второй браузер запускается лишь когда им пользуются.

Наружу порт не опубликован — к роботу ходит только приложение (ключ в заголовке
X-Robot-Key, лежит в data/robot/.robot_api_key, создаёт приложение).
"""
from __future__ import annotations

import asyncio
import base64
import collections
import hmac
import logging
import os
import socket
import ssl
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, Field
from playwright.async_api import BrowserContext, Page, async_playwright

import constructor
import forms as yforms
from pagewait import ACTION_TIMEOUT_MS, SAFETY_CAP, settle, watch

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("robot")

PROFILE_DIR = Path(os.environ.get("ROBOT_PROFILE_DIR", "/profile"))
KEY_FILE = Path(os.environ.get("ROBOT_KEY_FILE", "/robot/.robot_api_key"))
SHOTS_DIR = Path(os.environ.get("ROBOT_SHOTS_DIR", str(PROFILE_DIR / "shots")))
HEADLESS = os.environ.get("ROBOT_HEADLESS", "1") != "0"
NO_SANDBOX = os.environ.get("ROBOT_NO_SANDBOX", "1") != "0"  # в Docker браузер работает от root
VIEWPORT = {"width": 1280, "height": 800}      # страницы заданий (Конструктору нужен просторный экран)
VIEW_VIEWPORT = {"width": 1280, "height": 760}  # окно входа в календаре: широкий экран; календарь присылает свои размеры (POST /view/resize) — окно на весь экран
VIEW_MIN, VIEW_MAX = (320, 240), (2560, 1600)
JOB_SAFETY_CAP = 840      # секунд: предел одного задания «карта» — только страховка от зависания; страницы ждём по состоянию загрузки (pagewait.py), не по времени
FORMS_SAFETY_CAP = 600    # то же для выгрузки таблицы ответов Яндекс Форм
LOGIN_URL = (
    "https://passport.yandex.ru/auth?retpath="
    + urllib.parse.quote("https://yandex.ru/map-constructor/", safe="")
)
PROFILES = ("maps", "forms")
FORMS_LOGIN_URL = (
    "https://passport.yandex.ru/auth?retpath="
    + urllib.parse.quote(yforms.FORMS_HOME, safe="")
)
# Только для проверок: дополнительные разрешённые адреса (например 127.0.0.1 для поддельной страницы Форм). В боевой настройке пусто.
_EXTRA_HOSTS = tuple(h.strip().lower() for h in os.environ.get("ROBOT_EXTRA_HOSTS", "").split(",") if h.strip())
# В окне входа разрешены только страницы Яндекса — робот не должен быть открытым прокси.
_ALLOWED_HOST_SUFFIXES = ("yandex.ru", "yandex.com", "ya.ru", "yandex.by", "yandex.kz")
_ALLOWED_KEYS = {
    "Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    "Home", "End", "PageUp", "PageDown", "Control+a", "Control+A",
}
MAX_JOBS_KEPT = 60


# Скрипт в каждой странице и в кадрах браузера робота: всё, что играет (<audio>/<video> и WebAudio), дублируется в запись WebM/Opus; куски записи уходят роботу
# через __lcAudio и дальше в окно календаря (кнопка «🔊 Звук»). Запись идёт всегда, а робот пересылает её, только пока окно открыто и просит звук.
AUDIO_TAP_JS = r"""(() => {
  if (window.__lcAudioTap) return;
  window.__lcAudioTap = true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !window.MediaRecorder || typeof window.__lcAudio !== 'function') return;
  const FID = Math.random().toString(36).slice(2, 8);
  let ac = null, dest = null, rec = null, runs = 0;
  const tapped = new WeakSet();
  const init = () => { if (!ac) { ac = new AC(); dest = ac.createMediaStreamDestination(); } return ac; };
  const startRec = () => {
    if (!dest) return;
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) { /* уже остановлена */ }
    let first = true;
    const sid = FID + '-' + (++runs);
    try { rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 }); } catch (e) { return; }
    rec.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      const wasFirst = first; first = false;
      ev.data.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf); let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        try { window.__lcAudio(sid, wasFirst, btoa(bin)); } catch (e) { /* окно закрылось */ }
      });
    };
    rec.start(250);
  };
  window.__lcAudioRestart = () => { if (dest) startRec(); };
  const tapEl = (el) => {
    if (tapped.has(el)) return;
    tapped.add(el);
    try { init(); const src = ac.createMediaElementSource(el); src.connect(dest); src.connect(ac.destination); if (ac.state === 'suspended') ac.resume(); if (!rec) startRec(); } catch (e) { /* нельзя перехватить (чужой источник без CORS) */ }
  };
  setInterval(() => document.querySelectorAll('audio,video').forEach(tapEl), 700);
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...rest) {
    const r = origConnect.call(this, target, ...rest);
    try {
      if (target instanceof AudioDestinationNode && this.context !== ac) {
        if (!this.context.__lcTap) { this.context.__lcTap = this.context.createMediaStreamDestination(); init(); ac.createMediaStreamSource(this.context.__lcTap.stream).connect(dest); if (!rec) startRec(); }
        origConnect.call(this, this.context.__lcTap);
      }
    } catch (e) { /* не страшно */ }
    return r;
  };
})();"""


class AudioRelay:
    """Звук страницы окна входа: куски записи от страниц (on_chunk) складываются в короткую очередь; окно календаря забирает их долгим опросом."""

    def __init__(self) -> None:
        self.chunks: "collections.deque[tuple[int, str, bytes]]" = collections.deque(maxlen=240)
        self.seq = 0
        self.stream = ""
        self.cond: Optional[asyncio.Condition] = None
        self.until = 0.0

    def want(self) -> None:
        self.until = time.monotonic() + 30

    async def on_chunk(self, source, stream_id: str, first: bool, b64: str) -> None:
        if time.monotonic() > self.until:
            return                                   # окно звук не просит — не копим
        if first:
            self.stream = stream_id                  # самая свежая запись (после перезапуска или новый кадр) — единственная, что отдаём
        if stream_id != self.stream:
            return
        if self.cond is None:
            self.cond = asyncio.Condition()
        async with self.cond:
            self.seq += 1
            self.chunks.append((self.seq, stream_id, base64.b64decode(b64)))
            self.cond.notify_all()

    async def wait(self, after: int, wait: float) -> tuple[int, str, bytes]:
        self.want()
        if self.cond is None:
            self.cond = asyncio.Condition()
        async with self.cond:
            if self.seq <= after and wait > 0:
                try:
                    await asyncio.wait_for(self.cond.wait_for(lambda: self.seq > after), wait)
                except asyncio.TimeoutError:
                    pass
            items = [c for c in self.chunks if c[0] > after and c[1] == self.stream]
            return self.seq, self.stream, b"".join(c[2] for c in items)


class Robot:
    """Ленивый запуск браузера: контейнер стоит дёшево, пока им не пользуются."""

    def __init__(self, name: str = "maps", subdir: str = "chrome") -> None:
        self.name = name
        self.subdir = subdir
        self.view_size = dict(VIEW_VIEWPORT)
        self.audio = AudioRelay()
        self._pw = None
        self.ctx: Optional[BrowserContext] = None
        self.view: Optional[Page] = None
        self._start_lock = asyncio.Lock()
        self.forms_warm = 0.0
        self.job_lock = asyncio.Lock()
        self.jobs: dict[str, dict[str, Any]] = {}
        self.chrome_version = ""

    async def _alive(self) -> bool:
        if self.ctx is None:
            return False
        try:
            _ = self.ctx.pages
            await self.ctx.cookies(["https://yandex.ru"])
            return True
        except Exception:  # noqa: BLE001
            return False

    async def get_ctx(self) -> BrowserContext:
        async with self._start_lock:
            if await self._alive():
                return self.ctx  # type: ignore[return-value]
            await self._stop_quietly()
            PROFILE_DIR.mkdir(parents=True, exist_ok=True)
            SHOTS_DIR.mkdir(parents=True, exist_ok=True)
            log.info("Запускаю браузер «%s» (профиль %s)", self.name, PROFILE_DIR / self.subdir)
            self._pw = await async_playwright().start()
            args = ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--lang=ru-RU", "--autoplay-policy=no-user-gesture-required"]
            if NO_SANDBOX:
                args.append("--no-sandbox")
            ctx = await self._pw.chromium.launch_persistent_context(
                str(PROFILE_DIR / self.subdir),
                headless=HEADLESS,
                viewport=VIEWPORT,
                locale="ru-RU",
                timezone_id="Europe/Moscow",
                args=args,
                ignore_default_args=["--enable-automation"],
            )
            self.chrome_version = ctx.browser.version if ctx.browser else ""
            # Обычный «человеческий» вид: без HeadlessChrome в User-Agent и без navigator.webdriver.
            await ctx.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});")
            # Звук страниц (например, голосовая проверка «Вы не робот») пересылается в окно календаря: скрипт в каждой странице и в кадрах пишет звук в WebM/Opus
            await ctx.expose_binding("__lcAudio", self.audio.on_chunk)
            await ctx.add_init_script(AUDIO_TAP_JS)
            ctx.on("dialog", lambda d: asyncio.ensure_future(_accept_dialog(d)))
            self.ctx = ctx
            self.view = None
            return ctx

    async def _stop_quietly(self) -> None:
        try:
            if self.ctx is not None:
                await self.ctx.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            if self._pw is not None:
                await self._pw.stop()
        except Exception:  # noqa: BLE001
            pass
        self.ctx = None
        self._pw = None
        self.view = None

    async def view_page(self) -> Page:
        ctx = await self.get_ctx()
        if self.view is None or self.view.is_closed():
            self.view = await ctx.new_page()
            await self.view.set_viewport_size(self.view_size)
        return self.view

    async def shutdown(self) -> None:
        await self._stop_quietly()


async def _accept_dialog(dialog) -> None:
    try:
        await dialog.accept()
    except Exception:  # noqa: BLE001
        pass


robots = {"maps": Robot("maps", "chrome"), "forms": Robot("forms", "chrome_forms")}
robot = robots["maps"]          # задания Конструктора и их очередь — только у «maps»
app = FastAPI(title="Yandex Map Robot", docs_url=None, redoc_url=None, openapi_url=None)


def pick(profile: str) -> Robot:
    if profile not in robots:
        raise HTTPException(400, "Неизвестный профиль браузера (maps или forms)")
    return robots[profile]


@app.on_event("shutdown")
async def _shutdown() -> None:
    for r in robots.values():
        await r.shutdown()


def require_key(x_robot_key: str | None = Header(default=None)) -> None:
    try:
        key = KEY_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        raise HTTPException(503, "Ключ робота ещё не создан приложением (запустите приложение)")
    if not key or not x_robot_key or not hmac.compare_digest(x_robot_key, key):
        raise HTTPException(401, "Неверный ключ")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True}


async def _account(ctx: BrowserContext) -> dict[str, Any]:
    cookies = await ctx.cookies(["https://yandex.ru", "https://passport.yandex.ru", *(f"http://{h}" for h in _EXTRA_HOSTS)])
    names = {c["name"]: c["value"] for c in cookies}
    login = urllib.parse.unquote(names.get("yandex_login", "")).strip()
    return {"has_session": "Session_id" in names, "login": login}


# Адреса, которые нужны страницам Яндекса (сняты с живой загрузки страниц входа,
# Конструктора и карты). «Нужно» — без этих страниц робот не работает; остальное —
# карта/плитки/статистика, без них страницы могут грузиться медленнее или без фона.
NETCHECK_HOSTS = [
    ("yandex.ru", True, "Конструктор карт и карты по ссылке"),
    ("passport.yandex.ru", True, "вход в аккаунт Яндекса"),
    ("yastatic.net", True, "скрипты и стили страниц Яндекса"),
    ("api-maps.yandex.ru", True, "движок карты"),
    ("forms.yandex.ru", False, "файлы Яндекс Форм (скачивание фото из таблицы формы)"),
    ("maps.yastatic.net", False, "скрипты карты по ссылке"),
    ("core-renderer-tiles.maps.yandex.net", False, "плитки карты"),
    ("core-renderer-tiles.maps.yandex.ru", False, "плитки карты"),
    ("api.passport.yandex.ru", False, "вход в аккаунт (дополнительно)"),
    ("mc.yandex.ru", False, "Яндекс.Метрика (не обязателен)"),
    ("csp.yandex.net", False, "отчёты безопасности страниц (не обязателен)"),
]


async def _probe_host(host: str) -> dict[str, Any]:
    """Достучаться до host:443 с TLS-рукопожатием — так, как это сделает браузер."""
    started = time.monotonic()
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, 443, ssl=ssl.create_default_context()), timeout=8)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        return {"ok": True, "ms": round((time.monotonic() - started) * 1000), "error": ""}
    except socket.gaierror:
        error = "адрес не находится (DNS) — домен не разрешается"
    except asyncio.TimeoutError:
        error = "нет ответа за 8 секунд — вероятно, закрыт фильтром"
    except ssl.SSLError as exc:
        error = f"ошибка TLS ({exc.reason or 'сертификат'}) — возможна подмена сертификата"
    except OSError as exc:
        error = f"соединение не установлено ({exc.strerror or type(exc).__name__})"
    return {"ok": False, "ms": None, "error": error}


@app.get("/netcheck", dependencies=[Depends(require_key)])
async def netcheck() -> dict[str, Any]:
    """Доступность нужных Яндексу адресов — из контейнера робота, то есть так, как их увидит его браузер."""
    results = await asyncio.gather(*(_probe_host(h) for h, _, _ in NETCHECK_HOSTS))
    items = [{"host": h, "required": req, "purpose": why, **res} for (h, req, why), res in zip(NETCHECK_HOSTS, results)]
    return {"items": items, "required_ok": all(i["ok"] for i in items if i["required"])}


@app.get("/status", dependencies=[Depends(require_key)])
async def status(verify: bool = False, profile: str = "maps", check: str = "") -> dict[str, Any]:
    """verify=1 — настоящая проверка (maps: открывает Конструктор; forms: открывает список Яндекс Форм); без неё — по cookie."""
    rb = pick(profile)
    ctx = await rb.get_ctx()
    info = await _account(ctx)
    out: dict[str, Any] = {
        "ready": True,
        "profile": profile,
        "chrome": rb.chrome_version,
        "has_session": info["has_session"],
        "login": info["login"],
        "busy": rb.job_lock.locked(),
        "viewport": rb.view_size,
    }
    if verify:
        ok, message = await (yforms.is_logged_in(ctx) if (check == "forms" or (not check and profile == "forms")) else constructor.is_logged_in(ctx))
        out["checked"] = "forms" if (check == "forms" or (not check and profile == "forms")) else "maps"
        out["logged_in"] = ok
        out["message"] = message
        info = await _account(ctx)
        out["login"] = info["login"]
    else:
        out["logged_in"] = info["has_session"]
    return out


# ---------------------------------------------------------------- окно для входа

def _check_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    if host in _EXTRA_HOSTS:
        return url
    if parsed.scheme != "https" or not any(host == s or host.endswith("." + s) for s in _ALLOWED_HOST_SUFFIXES):
        raise HTTPException(400, "Разрешены только страницы Яндекса (https)")
    return url


class OpenIn(BaseModel):
    url: str = ""  # пусто → страница входа Яндекса


class ClickIn(BaseModel):
    x: float = Field(ge=0, le=5000)
    y: float = Field(ge=0, le=5000)
    double: bool = False


class TypeIn(BaseModel):
    text: str = Field(max_length=2000)


class KeyIn(BaseModel):
    key: str


class ScrollIn(BaseModel):
    dy: float = Field(default=300, ge=-5000, le=5000)


class ViewStream:
    """Экран окна входа (у каждого профиля свой): браузер сам присылает кадры (CDP screencast), как только страница
    меняется, а запрос /view?after=N ждёт следующего кадра (долгий опрос) — вместо снимка
    страницы по таймеру. Работает только пока окно открыто: без запросов 20 секунд — выключается."""

    MIN_FRAME_GAP = 0.08  # не чаще ~12 кадров в секунду — бережём процессор

    def __init__(self) -> None:
        self.cdp = None
        self.page: Optional[Page] = None
        self.frame = b""
        self.seq = 0
        self.cond: Optional[asyncio.Condition] = None
        self.last_request = 0.0
        self.active = False
        self.size: dict[str, int] = {}

    async def ensure(self, page: Page, size: dict[str, int]) -> None:
        self.last_request = time.monotonic()
        if self.active and self.page is page and not page.is_closed() and self.size == size:
            return
        await self.stop()
        self.size = dict(size)
        self.frame = b""                # кадр прежнего размера отдавать нельзя — ждём первый кадр нового
        self.seq = max(self.seq, 0)
        if self.cond is None:
            self.cond = asyncio.Condition()
        cdp = await page.context.new_cdp_session(page)
        cdp.on("Page.screencastFrame", lambda params: asyncio.ensure_future(self._on_frame(cdp, params)))
        await cdp.send(
            "Page.startScreencast",
            {"format": "jpeg", "quality": 55, "maxWidth": size["width"], "maxHeight": size["height"], "everyNthFrame": 1},
        )
        self.cdp, self.page, self.active = cdp, page, True
        asyncio.ensure_future(self._idle_watch())

    async def _on_frame(self, cdp, params: dict) -> None:
        try:
            assert self.cond is not None
            async with self.cond:
                self.frame = base64.b64decode(params["data"])
                self.seq += 1
                self.cond.notify_all()
            await asyncio.sleep(self.MIN_FRAME_GAP)
            await cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
        except Exception:  # noqa: BLE001 — страница закрылась/перезапустилась
            pass

    async def _idle_watch(self) -> None:
        while self.active:
            await asyncio.sleep(5)
            if time.monotonic() - self.last_request > 20:
                await self.stop()

    async def stop(self) -> None:
        cdp, self.cdp, self.active = self.cdp, None, False
        if cdp is not None:
            try:
                await cdp.send("Page.stopScreencast")
                await cdp.detach()
            except Exception:  # noqa: BLE001
                pass

    async def wait_frame(self, after: int, wait: float) -> tuple[int, bytes]:
        assert self.cond is not None
        self.last_request = time.monotonic()
        async with self.cond:
            if self.seq <= after and wait > 0:
                try:
                    await asyncio.wait_for(self.cond.wait_for(lambda: self.seq > after), wait)
                except asyncio.TimeoutError:
                    pass
            return self.seq, self.frame


view_streams = {"maps": ViewStream(), "forms": ViewStream()}
view_stream = view_streams["maps"]
LOGIN_URLS = {"maps": LOGIN_URL, "forms": FORMS_LOGIN_URL}


@app.get("/view", dependencies=[Depends(require_key)])
async def view_image(after: int = -1, wait: float = 0.0, profile: str = "maps") -> Response:
    """Кадр окна входа. Без параметров — текущий кадр сразу. after=N&wait=S — ждать кадра новее N
    до S секунд (204, если ничего не изменилось). Заголовки: X-Frame-Seq, X-View-Width/Height."""
    rb = pick(profile)
    view_stream = view_streams[profile]
    page = await rb.view_page()
    if page.url in ("about:blank", ""):
        await page.goto(LOGIN_URLS[profile], wait_until="commit", timeout=30000)
    headers = {
        "Cache-Control": "no-store",
        "X-View-Width": str(rb.view_size["width"]),
        "X-View-Height": str(rb.view_size["height"]),
        "X-View-Url": urllib.parse.quote(page.url[:300], safe=":/?&=%"),
    }
    try:
        await view_stream.ensure(page, rb.view_size)
        seq, frame = await view_stream.wait_frame(after, min(max(wait, 0.0), 5.0))
        if not frame:  # первый кадр ещё не пришёл (поток только поднят или размер экрана сменился) — подождать следующий
            seq, frame = await view_stream.wait_frame(view_stream.seq, 4.0)
    except Exception:  # noqa: BLE001 — screencast недоступен: обычный снимок
        log.warning("Потоковая передача экрана недоступна, отдаю обычный снимок", exc_info=True)
        frame, seq = await page.screenshot(type="jpeg", quality=55), after + 1
    if not frame:
        frame, seq = await page.screenshot(type="jpeg", quality=55), seq + 1
    headers["X-Frame-Seq"] = str(seq)
    if after >= 0 and seq <= after:
        return Response(status_code=204, headers=headers)
    return Response(content=frame, media_type="image/jpeg", headers=headers)


@app.post("/view/open", dependencies=[Depends(require_key)])
async def view_open(body: OpenIn, profile: str = "maps") -> dict[str, Any]:
    page = await pick(profile).view_page()
    await page.goto(_check_url(body.url or LOGIN_URLS[profile]), wait_until="domcontentloaded", timeout=45000)
    return {"ok": True, "url": page.url}


class ResizeIn(BaseModel):
    width: int = Field(ge=VIEW_MIN[0], le=VIEW_MAX[0])
    height: int = Field(ge=VIEW_MIN[1], le=VIEW_MAX[1])


@app.post("/view/resize", dependencies=[Depends(require_key)])
async def view_resize(body: ResizeIn, profile: str = "maps") -> dict[str, Any]:
    """Подогнать экран браузера робота под окно календаря (на весь экран, без «квадрата»): страницы Яндекса тогда помещаются целиком."""
    rb = pick(profile)
    size = {"width": body.width // 2 * 2, "height": body.height // 2 * 2}
    if size == rb.view_size and rb.view is not None and not rb.view.is_closed():
        return {"ok": True, **size}
    rb.view_size = size
    page = await rb.view_page()
    await page.set_viewport_size(size)
    await view_streams[profile].stop()               # кадры теперь другого размера — поток поднимется заново со следующим запросом
    return {"ok": True, **size}


@app.post("/audio/start", dependencies=[Depends(require_key)])
async def audio_start(profile: str = "maps") -> dict[str, Any]:
    """Окно просит звук: запись во всех кадрах страницы начинается заново (чтобы пришёл заголовок потока)."""
    rb = pick(profile)
    page = await rb.view_page()
    rb.audio.want()
    rb.audio.stream = ""
    for frame in page.frames:
        try:
            await frame.evaluate("() => { if (window.__lcAudioRestart) window.__lcAudioRestart(); }")
        except Exception:  # noqa: BLE001 — кадр закрылся
            pass
    return {"ok": True}


@app.get("/audio", dependencies=[Depends(require_key)])
async def audio_chunks(after: int = -1, wait: float = 0.0, profile: str = "maps") -> Response:
    """Звук окна: куски WebM/Opus новее after (долгий опрос до wait секунд). X-Audio-Seq — номер последнего, X-Audio-Stream — запись (сменилась — начинать заново)."""
    seq, stream, data = await pick(profile).audio.wait(after, min(max(wait, 0.0), 5.0))
    headers = {"Cache-Control": "no-store", "X-Audio-Seq": str(seq), "X-Audio-Stream": stream}
    if not data:
        return Response(status_code=204, headers=headers)
    return Response(content=data, media_type="audio/webm", headers=headers)


@app.get("/view/url", dependencies=[Depends(require_key)])
async def view_url(profile: str = "maps") -> dict[str, Any]:
    """Адрес страницы, открытой сейчас в окне входа (чтобы запомнить страницу «Ответы» формы)."""
    page = await pick(profile).view_page()
    return {"url": page.url}


@app.post("/view/click", dependencies=[Depends(require_key)])
async def view_click(body: ClickIn, profile: str = "maps") -> dict[str, Any]:
    page = await pick(profile).view_page()
    await page.mouse.click(body.x, body.y, click_count=2 if body.double else 1)
    return {"ok": True}


@app.post("/view/type", dependencies=[Depends(require_key)])
async def view_type(body: TypeIn, profile: str = "maps") -> dict[str, Any]:
    page = await pick(profile).view_page()
    # Текст (в т.ч. пароль) в журнал не пишется — только длина.
    await page.keyboard.type(body.text, delay=12)
    return {"ok": True}


@app.post("/view/key", dependencies=[Depends(require_key)])
async def view_key(body: KeyIn, profile: str = "maps") -> dict[str, Any]:
    if body.key not in _ALLOWED_KEYS:
        raise HTTPException(400, "Такая клавиша не поддерживается")
    page = await pick(profile).view_page()
    await page.keyboard.press(body.key)
    return {"ok": True}


@app.post("/view/scroll", dependencies=[Depends(require_key)])
async def view_scroll(body: ScrollIn, profile: str = "maps") -> dict[str, Any]:
    page = await pick(profile).view_page()
    await page.mouse.wheel(0, body.dy)
    return {"ok": True}


@app.post("/account/logout", dependencies=[Depends(require_key)])
async def account_logout(profile: str = "maps") -> dict[str, Any]:
    """Выход: стираем cookie и данные сайтов браузера робота (сессия на стороне Яндекса
    остаётся до своего срока — отозвать её можно в настройках аккаунта Яндекса)."""
    rb = pick(profile)
    ctx = await rb.get_ctx()
    await ctx.clear_cookies()
    for page in list(ctx.pages):
        try:
            await page.evaluate("() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} }")
        except Exception:  # noqa: BLE001
            pass
    if rb.view is not None and not rb.view.is_closed():
        await rb.view.goto("about:blank")
    return {"ok": True}


# ---------------------------------------------------------------- скачивание файлов (фото из Яндекс Форм)

MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024
# Файлы форм (forms.yandex.ru/cloud/files?path=…) открываются только создателю формы — поэтому у робота для них отдельный вход (профиль «forms»).
# Скачивать можно только с адресов Яндекса (https): робот не должен быть открытым прокси.
_DOWNLOAD_HOSTS = ("forms.yandex.ru", "forms.yandex.net", "yandex.ru", "yandex.net", "yandexcloud.net", "yastatic.net")


class DownloadIn(BaseModel):
    url: str = Field(max_length=2000)
    profile: str = "auto"      # auto — под аккаунтом для Форм, если вход в него выполнен, иначе под аккаунтом карт (как было раньше)


async def _download_robot(profile: str) -> Robot:
    if profile in robots:
        return robots[profile]
    forms_robot = robots["forms"]
    if (PROFILE_DIR / forms_robot.subdir).exists():            # аккаунт для Форм заводили — смотрим, есть ли в нём вход
        info = await _account(await forms_robot.get_ctx())
        if info["has_session"]:
            return forms_robot
    return robots["maps"]


async def _warm_forms(rb: Robot, ctx: BrowserContext, force: bool = False) -> None:
    """Файлы Яндекс Форм открываются с cookie самих Форм, которые ставятся при заходе на forms.yandex.ru (вход в Яндекс сам по себе их не даёт).
    Поэтому перед скачиванием один раз за 10 минут «заходим» в Формы — как человек, открывший свою форму."""
    if not force and time.time() - rb.forms_warm < 600:
        return
    page = await ctx.new_page()
    watch(page)
    try:
        for home in (yforms.FORMS_BUSINESS_HOME, yforms.FORMS_HOME):
            await page.goto(home, wait_until="domcontentloaded", timeout=ACTION_TIMEOUT_MS)
            await settle(page, quiet=1.0)                       # ждём, пока страница загрузится (по состоянию, не по времени)
        rb.forms_warm = time.time()
    except Exception as exc:  # noqa: BLE001 — не вышло прогреть: скачивание всё равно попробуем
        log.warning("Прогрев сессии Яндекс Форм не удался: %s", exc)
    finally:
        try:
            await page.close()
        except Exception:  # noqa: BLE001
            pass


def _check_download_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    if host in _EXTRA_HOSTS:
        return url
    if parsed.scheme != "https" or not any(host == s or host.endswith("." + s) for s in _DOWNLOAD_HOSTS):
        raise HTTPException(400, "Скачивать можно только с адресов Яндекса (https)")
    return url


def _is_file_response(ctype: str, body: bytes) -> bool:
    """Не страница входа/ошибки, а сам файл."""
    if "text/html" in ctype or "application/json" in ctype or "text/plain" in ctype:
        return False
    return bool(body)


@app.post("/download", dependencies=[Depends(require_key)])
async def download_file(body: DownloadIn) -> Response:
    """Скачивает файл по ссылке браузером робота (с cookie его Яндекс-аккаунта) и отдаёт его байты. Сначала запросом в контексте
    браузера, а если ответ — страница (вход, «нет доступа»), то открытием ссылки в самой вкладке."""
    url = _check_download_url(body.url)
    rb = await _download_robot(body.profile)
    ctx = await rb.get_ctx()
    await _warm_forms(rb, ctx)
    ctype, data, status_code = "", b"", 0
    captcha = False
    try:
        resp = await ctx.request.get(url, timeout=60000, headers={"Referer": "https://forms.yandex.ru/", "Accept": "image/*,*/*;q=0.8"})
        status_code = resp.status
        ctype = (resp.headers.get("content-type") or "").lower()
        data = await resp.body() if resp.ok else b""
        captcha = yforms.is_captcha(resp.url)
    except Exception as exc:  # noqa: BLE001 — нет соединения с Яндексом: второй попыткой (вкладкой) его не появится
        log.warning("Скачивание %s: запрос не удался: %s", url[:120], exc)
        raise HTTPException(502, "Нет соединения с Яндексом из браузера робота (проверьте, что с сервера открыт HTTPS на forms.yandex.ru)")
    if not _is_file_response(ctype, data):
        page = await ctx.new_page()
        try:
            r = await page.goto(url, wait_until="commit", timeout=60000)
            if r is not None:
                status_code = r.status
                ctype = (r.headers.get("content-type") or "").lower()
                data = await r.body() if r.ok else b""
                captcha = captcha or yforms.is_captcha(r.url)
        except Exception as exc:  # noqa: BLE001
            log.warning("Скачивание %s: открытие вкладкой не удалось: %s", url[:120], exc)
        finally:
            try:
                await page.close()
            except Exception:  # noqa: BLE001
                pass
    if not _is_file_response(ctype, data):
        if captcha:
            raise HTTPException(409, yforms.CAPTCHA_TEXT, headers={"X-Error-Code": "captcha"})
        if status_code in (401, 403) or "text/html" in ctype:
            raise HTTPException(409, "Яндекс не отдаёт файл: в браузере робота не выполнен вход в аккаунт создателя формы "
                                     "(Настройки → «Яндекс Формы: вход и автозагрузка» → «Проверить скачивание фото» покажет причину) или у этого аккаунта нет доступа к форме"
                                     + ("" if rb.name == "forms" else " (используется тот же вход, что для карт)"))
        if status_code == 404:
            raise HTTPException(404, "Файла по ссылке уже нет")
        raise HTTPException(502, f"Не удалось получить файл (ответ {status_code or 'нет'})")
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise HTTPException(413, "Файл слишком большой")
    return Response(content=data, media_type=ctype.split(";")[0] or "application/octet-stream", headers={"Cache-Control": "no-store"})


DIAG_SHOT = SHOTS_DIR / "download-diag.jpg"
_TAGS_RE = __import__("re").compile(r"<(script|style)[^>]*>.*?</\1>|<[^>]+>", __import__("re").S | __import__("re").I)


def _brief(url: str) -> str:
    p = urllib.parse.urlparse(url)
    return (f"{p.scheme}://{p.hostname or ''}{p.path}" + (f"?{p.query}" if p.query else ""))[:240]


def _text_head(ctype: str, data: bytes) -> str:
    if not data or not any(t in ctype for t in ("html", "json", "text")):
        return ""
    text = _TAGS_RE.sub(" ", data[:60000].decode("utf-8", "replace"))
    return " ".join(text.split())[:300]


class DiagIn(BaseModel):
    url: str = Field(max_length=2000)
    profile: str = "maps"


@app.post("/download/diag", dependencies=[Depends(require_key)])
async def download_diag(body: DiagIn) -> dict[str, Any]:
    """Разбор «почему не скачалось»: что именно отвечает Яндекс на запрос и что браузер робота видит на странице по этой ссылке
    (снимок страницы — GET /download/diag/shot). Ничего не сохраняет."""
    url = _check_download_url(body.url)
    rb = pick(body.profile)
    ctx = await rb.get_ctx()
    info = await _account(ctx)
    out: dict[str, Any] = {"profile": rb.name, "has_session": info["has_session"], "login": info["login"], "steps": [], "has_shot": False, "captcha": False}
    DIAG_SHOT.unlink(missing_ok=True)
    await _warm_forms(rb, ctx, force=True)
    try:
        resp = await ctx.request.get(url, timeout=60000, headers={"Referer": "https://forms.yandex.ru/", "Accept": "image/*,*/*;q=0.8"})
        data = await resp.body()
        ctype = (resp.headers.get("content-type") or "").lower()
        out["steps"].append({"how": "запрос (как делает робот)", "status": resp.status, "type": ctype.split(";")[0], "bytes": len(data), "url": _brief(resp.url), "text": _text_head(ctype, data)})
        out["captcha"] = out["captcha"] or yforms.is_captcha(resp.url)
    except Exception as exc:  # noqa: BLE001
        out["steps"].append({"how": "запрос (как делает робот)", "error": f"{type(exc).__name__}: {str(exc).splitlines()[0][:200] if str(exc) else ''}"})
    page = await ctx.new_page()
    try:
        r = await page.goto(url, wait_until="load", timeout=60000)
        title = ""
        try:
            title = await page.title()
        except Exception:  # noqa: BLE001
            pass
        ctype2 = ((r.headers.get("content-type") if r else "") or "").lower()
        body2 = b""
        try:
            body2 = await r.body() if r else b""
        except Exception:  # noqa: BLE001
            pass
        out["steps"].append({"how": "открытие ссылки вкладкой", "status": r.status if r else None, "type": ctype2.split(";")[0], "bytes": len(body2),
                             "url": _brief(page.url), "title": title[:120], "text": _text_head(ctype2, body2)})
        out["captcha"] = out["captcha"] or yforms.is_captcha(page.url)
        try:
            DIAG_SHOT.parent.mkdir(parents=True, exist_ok=True)
            DIAG_SHOT.write_bytes(await page.screenshot(type="jpeg", quality=65, timeout=ACTION_TIMEOUT_MS))
            out["has_shot"] = True
        except Exception:  # noqa: BLE001
            pass
    except Exception as exc:  # noqa: BLE001
        out["steps"].append({"how": "открытие ссылки вкладкой", "error": f"{type(exc).__name__}: {str(exc).splitlines()[0][:200] if str(exc) else ''}"})
    finally:
        try:
            await page.close()
        except Exception:  # noqa: BLE001
            pass
    return out


@app.get("/download/diag/shot", dependencies=[Depends(require_key)])
async def download_diag_shot() -> Response:
    if not DIAG_SHOT.exists():
        raise HTTPException(404, "Снимка нет")
    return Response(content=DIAG_SHOT.read_bytes(), media_type="image/jpeg", headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- выгрузка таблицы ответов Яндекс Форм

FORMS_SHOT = SHOTS_DIR / "forms-export.jpg"
forms_lock = asyncio.Lock()
forms_state: dict[str, Any] = {"message": "", "at": 0.0}


class FormsExportIn(BaseModel):
    url: str = Field(max_length=2000)
    profile: str = "maps"       # под каким входом: maps — тот же, что для карт; forms — отдельный вход для Форм


@app.post("/forms/export", dependencies=[Depends(require_key)])
async def forms_export(body: FormsExportIn) -> Response:
    """Выгружает таблицу ответов формы (.xlsx) под аккаунтом создателя формы (профиль «forms»): страница «Ответы» → «XLSX с доп.полями» → «Скачать»."""
    url = _check_url(body.url)
    if forms_lock.locked():
        raise HTTPException(409, "Выгрузка ответов уже идёт — подождите")
    async with forms_lock:
        rb = pick(body.profile)
        FORMS_SHOT.unlink(missing_ok=True)
        try:
            ctx = await rb.get_ctx()
            data = await asyncio.wait_for(
                yforms.export_answers(ctx, url, shot_path=FORMS_SHOT, step=lambda m: forms_state.update(message=m, at=time.time())), timeout=FORMS_SAFETY_CAP,
            )
        except yforms.FormsError as exc:
            log.warning("Выгрузка ответов формы: %s — %s", exc.code, exc.message)
            raise HTTPException(409 if exc.code in ("not_logged_in", "captcha") else 502, exc.message, headers={"X-Error-Code": exc.code, "X-Has-Shot": "1" if FORMS_SHOT.exists() else "0"})
        except asyncio.TimeoutError:
            raise HTTPException(504, "Страница Яндекс Форм не загрузилась и не ответила за 10 минут — выгрузка остановлена")
    return Response(content=data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Cache-Control": "no-store"})


@app.get("/forms/export/shot", dependencies=[Depends(require_key)])
async def forms_export_shot() -> Response:
    if not FORMS_SHOT.exists():
        raise HTTPException(404, "Снимка нет")
    return Response(content=FORMS_SHOT.read_bytes(), media_type="image/jpeg", headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- задания «создать карту»

class PointIn(BaseModel):
    """Точка карты для точечного обновления: координаты, подпись метки, описание, цвет (hex без #)."""
    lat: str = Field(max_length=32)
    lon: str = Field(max_length=32)
    caption: str = Field(default="", max_length=200)
    desc: str = Field(default="", max_length=2000)
    color: str = Field(default="1E98FF", max_length=7, pattern="^#?[0-9a-fA-F]{6}$")


class ChangeIn(BaseModel):
    """Изменение уже стоящей на карте точки: найти по подписи (и началу прежнего описания) и поправить."""
    caption: str = Field(default="", max_length=200)
    old_desc: str = Field(default="", max_length=2000)
    desc: Optional[str] = Field(default=None, max_length=2000)   # None — описание не менять
    color: Optional[str] = Field(default=None, max_length=7, pattern="^#?[0-9a-fA-F]{6}$")  # None — цвет не менять


class JobIn(BaseModel):
    kind: str = Field(default="create", pattern="^(create|delete|patch|read)$")
    name: str = Field(default="", max_length=200)
    filename: str = Field(default="points.xlsx", max_length=120)
    xlsx_b64: str = Field(default="", max_length=8_000_000)
    # create: после успешного создания удалить эту (прежнюю) карту — «обновление целиком».
    # delete / patch: карта, с которой работаем. Идентификатор — хэш из ссылки (um=constructor%3A<хэш>).
    map_id: str = Field(default="", max_length=80, pattern="^[0-9a-fA-F]*$")
    # patch: что убрать с карты и что добавить; expected_total — сколько точек должно стать на карте.
    add: list[PointIn] = Field(default_factory=list, max_length=60)
    remove: list[PointIn] = Field(default_factory=list, max_length=60)
    change: list[ChangeIn] = Field(default_factory=list, max_length=60)
    expected_total: Optional[int] = Field(default=None, ge=0, le=5000)
    debug: bool = False   # patch: сохранять снимок экрана после каждого шага (для разбора сбоев)
    meta: dict[str, Any] = {}


def _public(job: dict[str, Any]) -> dict[str, Any]:
    return {k: job.get(k) for k in ("id", "kind", "state", "message", "url", "error_code", "meta", "created", "finished", "has_shot", "old_deleted", "objects")}


async def _run_job(job: dict[str, Any], content: bytes, body: JobIn) -> None:
    async with robot.job_lock:
        job["state"] = "running"
        job["message"] = "Запускаю браузер…"

        def step(msg: str) -> None:
            job["message"] = msg

        async def shot(page: Page) -> None:
            try:
                SHOTS_DIR.mkdir(parents=True, exist_ok=True)
                data = await page.screenshot(type="jpeg", quality=70, timeout=ACTION_TIMEOUT_MS)
                (SHOTS_DIR / f"{job['id']}.jpg").write_bytes(data)
                job["has_shot"] = True
            except Exception:  # noqa: BLE001
                pass

        async def snap(page: Page, label: str) -> None:
            try:
                SHOTS_DIR.mkdir(parents=True, exist_ok=True)
                await settle(page, quiet=0.8, cap=30)
                (SHOTS_DIR / f"{job['id']}-{label}.jpg").write_bytes(await page.screenshot(type="jpeg", quality=70, timeout=ACTION_TIMEOUT_MS))
            except Exception:  # noqa: BLE001
                pass

        try:
            ctx = await robot.get_ctx()
            if body.kind == "patch":
                url = await asyncio.wait_for(
                    constructor.patch_map(
                        ctx, map_id=body.map_id.lower(), name=body.name,
                        add=[p.model_dump() for p in body.add], remove=[p.model_dump() for p in body.remove],
                        change=[p.model_dump() for p in body.change],
                        expected_total=body.expected_total, step=step, shot=shot, snap=snap if body.debug else None,
                    ),
                    timeout=JOB_SAFETY_CAP,
                )
                job.update(state="done", url=url, message="Карта обновлена")
                log.info("Задание %s: карта обновлена точечно (+%d −%d ~%d)", job["id"], len(body.add), len(body.remove), len(body.change))
            elif body.kind == "read":
                texts = await asyncio.wait_for(constructor.read_map(ctx, map_id=body.map_id.lower(), step=step, shot=shot), timeout=JOB_SAFETY_CAP)
                job.update(state="done", objects=texts, message=f"На карте точек: {len(texts)}", url=None)
                log.info("Задание %s: карта прочитана (%d точек)", job["id"], len(texts))
            elif body.kind == "delete":
                removed = await asyncio.wait_for(constructor.delete_map(ctx, map_id=body.map_id.lower(), step=step, shot=shot), timeout=JOB_SAFETY_CAP)
                job.update(state="done", message="Карта удалена" if removed else "Карты уже не было в Конструкторе", url=None)
                log.info("Задание %s: карта удалена (%s)", job["id"], "была" if removed else "уже не было")
            else:
                url = await asyncio.wait_for(
                    constructor.create_map(ctx, name=body.name, filename=body.filename, content=content, step=step, shot=shot),
                    timeout=JOB_SAFETY_CAP,
                )
                log.info("Задание %s: карта создана", job["id"])
                message = "Готово"
                if body.map_id and constructor.map_id_from_url(url) != body.map_id.lower():
                    # Прежнюю карту удаляем после того, как новая сохранена; сбой удаления — не ошибка задания.
                    # «Готово» ставим только после этого шага, чтобы результат удаления (old_deleted) был окончательным.
                    try:
                        step("Удаляю прежнюю карту…")
                        gone = await asyncio.wait_for(constructor.delete_map(ctx, map_id=body.map_id.lower(), step=step, shot=shot), timeout=JOB_SAFETY_CAP)
                        job["old_deleted"] = bool(gone) or None
                        message = "Готово (прежняя карта удалена)" if gone else "Готово"
                    except Exception as exc:  # noqa: BLE001
                        job["old_deleted"] = False
                        message = "Готово, но прежнюю карту удалить не удалось"
                        log.warning("Задание %s: прежнюю карту не удалось удалить: %s", job["id"], exc)
                job.update(state="done", url=url, message=message)
        except constructor.RobotError as exc:
            where = job.get("message") or ""                    # к этому моменту там последний шаг («Убираю точки (2 из 5)…»): по нему видно, на чём остановились
            tail = f" [шаг: {where.rstrip('….')}]" if exc.code in ("timeout", "page_changed", "patch_failed") and where and where != "Запускаю браузер…" else ""
            job.update(state="error", error_code=exc.code, message=exc.message + tail)
            log.warning("Задание %s: %s — %s", job["id"], exc.code, exc.message)
        except asyncio.TimeoutError:
            job.update(state="error", error_code="timeout", message="Страница Яндекса не загрузилась и не ответила за 14 минут — робот остановил задание (проверьте связь сервера с Яндексом)")
            log.warning("Задание %s: таймаут", job["id"])
        except Exception as exc:  # noqa: BLE001
            job.update(state="error", error_code="unknown", message=f"Сбой робота: {type(exc).__name__}: {str(exc)[:200]}")
            log.exception("Задание %s: сбой", job["id"])
        finally:
            job["finished"] = time.time()
            _trim_jobs()


def _trim_jobs() -> None:
    if len(robot.jobs) <= MAX_JOBS_KEPT:
        return
    old = sorted(robot.jobs.values(), key=lambda j: j["created"])[: len(robot.jobs) - MAX_JOBS_KEPT]
    for j in old:
        if j["state"] in ("done", "error"):
            robot.jobs.pop(j["id"], None)
            try:
                (SHOTS_DIR / f"{j['id']}.jpg").unlink(missing_ok=True)
            except OSError:
                pass


@app.post("/jobs", dependencies=[Depends(require_key)])
async def create_job(body: JobIn) -> dict[str, Any]:
    content = b""
    if body.kind == "create":
        if not body.name.strip():
            raise HTTPException(400, "Нужно название карты")
        try:
            content = base64.b64decode(body.xlsx_b64, validate=True)
        except Exception:  # noqa: BLE001
            raise HTTPException(400, "Файл должен быть в base64")
        if not content:
            raise HTTPException(400, "Нет файла с точками")
    elif not body.map_id:
        raise HTTPException(400, "Нужен идентификатор карты")
    elif body.kind == "patch" and not body.name.strip():
        raise HTTPException(400, "Нужно название карты")
    job = {
        "id": uuid.uuid4().hex[:12], "kind": body.kind, "state": "queued", "message": "В очереди", "url": None,
        "error_code": None, "meta": body.meta, "created": time.time(), "finished": None, "has_shot": False, "old_deleted": None,
    }
    robot.jobs[job["id"]] = job
    asyncio.ensure_future(_run_job(job, content, body))
    return _public(job)


@app.get("/jobs/{job_id}", dependencies=[Depends(require_key)])
async def get_job(job_id: str) -> dict[str, Any]:
    job = robot.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Задание не найдено (робот перезапускался?)")
    return _public(job)


@app.get("/jobs/{job_id}/shot", dependencies=[Depends(require_key)])
async def get_job_shot(job_id: str) -> Response:
    path = SHOTS_DIR / f"{job_id}.jpg"
    if not job_id.isalnum() or not path.exists():
        raise HTTPException(404, "Снимка нет")
    return Response(content=path.read_bytes(), media_type="image/jpeg", headers={"Cache-Control": "no-store"})
