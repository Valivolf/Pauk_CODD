FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TZ=Europe/Moscow

WORKDIR /app

# Браузер Chromium (~400 МБ с системными библиотеками и шрифтами) скачивается при сборке
# образа — серверу нужен выход в интернет только на этот шаг и потом при работе
# робота (yandex.ru). Основное приложение (lan-calendar) от этого образа не зависит.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY server.py constructor.py forms.py pagewait.py ./

# Профиль браузера (вход в Яндекс) — в томе, переживает пересборку контейнера.
RUN mkdir -p /profile
VOLUME /profile

EXPOSE 8100

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8100"]
