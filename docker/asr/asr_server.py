"""Распознавание речи для приложения: faster-whisper (CTranslate2, int8, процессор). Небольшой HTTP-сервис внутри сети compose:
  GET  /health      — готовность (модель найдена; загружается ли ещё);
  POST /transcribe  — файл голосового сообщения (mp3/ogg/wav…) → {"text", "language", "duration"}.
Запись раскладывается на куски по паузам (vad_filter), поэтому тишина и шум между фразами не «галлюцинируются». `prompt` — слова из работы
(АПК, СЭС, блок питания…): модель лучше узнаёт их в речи."""
import logging
import os
import tempfile
import threading
import time

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

MODEL_DIR = os.environ.get("ASR_MODEL_DIR", "/models/whisper-large-v3-turbo")
THREADS = int(os.environ.get("ASR_THREADS", "4"))
COMPUTE = os.environ.get("ASR_COMPUTE", "int8")
BEAM = int(os.environ.get("ASR_BEAM", "3"))

logger = logging.getLogger("asr")

try:        # свежий PyAV не принимает параметр, который передаёт faster-whisper (metadata_errors) — убираем его на лету
    import av

    _av_open = av.open

    def _compat_open(*args, **kwargs):
        try:
            return _av_open(*args, **kwargs)
        except TypeError:
            kwargs.pop("metadata_errors", None)
            return _av_open(*args, **kwargs)

    av.open = _compat_open
except ImportError:
    pass

app = FastAPI(title="asr")
_state = {"model": None, "loading": False, "error": ""}
_lock = threading.Lock()


def _load() -> None:
    with _lock:
        if _state["model"] is not None:
            return
        _state["loading"] = True
        try:
            from faster_whisper import WhisperModel

            _state["model"] = WhisperModel(MODEL_DIR, device="cpu", compute_type=COMPUTE, cpu_threads=THREADS)
            _state["error"] = ""
        except Exception as exc:  # noqa: BLE001
            _state["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            _state["loading"] = False


@app.on_event("startup")
def _warm() -> None:
    if os.path.exists(os.path.join(MODEL_DIR, "model.bin")):
        threading.Thread(target=_load, daemon=True).start()          # грузим модель сразу, не ждём первого голосового


@app.get("/health")
def health():
    if not os.path.exists(os.path.join(MODEL_DIR, "model.bin")):
        return JSONResponse({"status": "no-model", "detail": f"в {MODEL_DIR} нет модели"}, status_code=503)
    if _state["model"] is None:
        return JSONResponse({"status": "loading" if _state["loading"] else "error", "detail": _state["error"]}, status_code=503)
    return {"status": "ok", "model": os.path.basename(MODEL_DIR.rstrip("/")), "compute": COMPUTE, "threads": THREADS}


def _transcribe(path: str, language: str, prompt: str) -> dict:
    _load()
    model = _state["model"]
    if model is None:
        raise HTTPException(503, "Модель распознавания ещё не загружена")
    started = time.time()
    segments, info = model.transcribe(
        path, language=language or None, initial_prompt=prompt or None, beam_size=BEAM, vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500}, condition_on_previous_text=False, temperature=0.0,
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return {"text": text, "language": info.language, "duration": round(info.duration, 1), "seconds": round(time.time() - started, 1)}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str = Form("ru"), prompt: str = Form("")):
    data = await file.read()
    if not data:
        raise HTTPException(400, "Пустой файл")
    suffix = os.path.splitext(file.filename or "")[1][:8] or ".ogg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        path = tmp.name
    try:
        return await run_in_threadpool(_transcribe, path, language, prompt[:500])
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — битый файл и т. п.
        logger.exception("не удалось распознать запись")
        raise HTTPException(422, f"Не удалось прочитать запись: {type(exc).__name__}: {str(exc)[:120]}") from exc
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
