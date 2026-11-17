FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Europe/Moscow

WORKDIR /app

# iputils-ping используется проверкой доступности («Пинг» в справочнике АПК и фоновым мониторингом),
# python3 + smbprotocol — встроенным в приложение SMB2/SMB3-клиентом для сетевого диска с фото (без монтирования на хосте Ubuntu).
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping python3 python3-pip \
    && pip3 install --no-cache-dir --break-system-packages smbprotocol \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY server.ts ./
COPY server ./server
COPY bot ./bot
COPY templates ./templates
COPY static ./static

RUN mkdir -p /app/data /app/backups

EXPOSE 3000

CMD ["./node_modules/.bin/tsx", "server.ts"]
