FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1

WORKDIR /app

# faster-whisper (CTranslate2) умеет декодировать mp3/ogg сам (PyAV внутри) — системный ffmpeg не нужен.
RUN pip install --no-cache-dir --retries 15 --default-timeout 120 faster-whisper fastapi "uvicorn[standard]" python-multipart

COPY asr_server.py /app/asr_server.py

EXPOSE 8000
CMD ["uvicorn", "asr_server:app", "--host", "0.0.0.0", "--port", "8000"]
