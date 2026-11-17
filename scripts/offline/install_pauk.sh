#!/usr/bin/env bash
# Параллельная установка/обновление системы «Паук» на рабочий сервер БЕЗ интернета
# рядом со старой версией (/opt/lan_calendar) в отдельную папку (/opt/pauk)
# и на отдельный HTTPS-порт (по умолчанию 8443, не затрагивая 80 и 443).
#
# Примеры запуска:
#   sudo bash install.sh
#   sudo bash install.sh --port 8443 --target /opt/pauk --from /opt/lan_calendar
#   sudo bash install.sh --copy-db        # принудительно перекопировать свежую БД со старой версии
#   sudo bash install.sh --with-bot       # также запустить VK-бота в новой копии
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

TARGET="/opt/pauk"
SOURCE_OLD="/opt/lan_calendar"
HTTPS_PORT="8443"
APP_PORT="3010"
FORCE_COPY_DB=""
WITH_BOT=""
CHECK_ONLY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --target)      TARGET="$2"; shift 2 ;;
    --from)        SOURCE_OLD="$2"; shift 2 ;;
    --port)        HTTPS_PORT="$2"; shift 2 ;;
    --app-port)    APP_PORT="$2"; shift 2 ;;
    --copy-db)     FORCE_COPY_DB="1"; shift ;;
    --with-bot)    WITH_BOT="1"; shift ;;
    --check)       CHECK_ONLY="1"; shift ;;
    -h|--help)
      echo "Использование: sudo bash install.sh [--port 8443] [--app-port 3010] [--target /opt/pauk] [--from /opt/lan_calendar] [--copy-db] [--with-bot]"
      exit 0
      ;;
    /*)
      TARGET="$1"; shift ;;
    *)
      echo "Неизвестный параметр: $1"
      exit 1
      ;;
  esac
done

if [ "$HTTPS_PORT" = "80" ] || [ "$HTTPS_PORT" = "443" ]; then
  echo "ОШИБКА: Порт $HTTPS_PORT занят основной системой. Укажите отдельный HTTPS-порт (например, --port 8443)."
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
# shellcheck source=selftest_pauk.sh
. "$HERE/selftest_pauk.sh"

docker info >/dev/null 2>&1 || { echo "Нет доступа к Docker. Запустите с правами: sudo bash install.sh"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Не найден «docker compose» (нужен Compose v2)."; exit 1; }

if [ -n "$CHECK_ONLY" ]; then
  st_selftest_pauk "$TARGET" "$HTTPS_PORT" "$APP_PORT" "" ""
  st_report
  exit $?
fi

echo "=================================================================="
echo " Установка системы «Паук» (параллельно со старой версией)"
echo " Папка установки : $TARGET"
echo " Источник данных : $SOURCE_OLD"
echo " HTTPS-порт      : $HTTPS_PORT (не занимает 80 и 443)"
echo " Локальный порт  : 127.0.0.1:$APP_PORT"
echo " Сборка пакета   : $(cat "$HERE/BUILD" 2>/dev/null || echo 'не указана')"
echo "=================================================================="

# Запомним, какие контейнеры старой системы работали до установки, чтобы убедиться, что мы их не затронули.
OLD_RUNNING=""
for c in lan-calendar codd-bot lan-calendar-caddy yandex-robot; do
  if st_container_running "$c"; then
    OLD_RUNNING="$OLD_RUNNING $c"
  fi
done

echo "[1/6] Проверяю целостность архива…"
(cd "$HERE" && sha256sum -c SHA256SUMS)

echo "[2/6] Загружаю Docker-образы «Паук» (без выхода в интернет)…"
docker tag pauk:latest pauk:previous 2>/dev/null || true
gunzip -c "$HERE/pauk.tar.gz" | docker load
echo "      загружен образ приложения pauk:latest"

if [ -f "$HERE/pauk-caddy.tar.gz" ]; then
  gunzip -c "$HERE/pauk-caddy.tar.gz" | docker load
  echo "      загружен образ HTTPS-прокси pauk-caddy:latest"
elif docker image inspect lan-calendar-caddy:latest >/dev/null 2>&1; then
  docker tag lan-calendar-caddy:latest pauk-caddy:latest
  echo "      использован локальный образ lan-calendar-caddy:latest -> pauk-caddy:latest"
fi

HAS_ROBOT_IMAGE=""
if [ -f "$HERE/pauk-robot.tar.gz" ]; then
  gunzip -c "$HERE/pauk-robot.tar.gz" | docker load
  HAS_ROBOT_IMAGE="1"
  echo "      загружен образ браузера pauk-robot:latest (Chromium внутри)"
elif docker image inspect pauk-robot:latest >/dev/null 2>&1; then
  HAS_ROBOT_IMAGE="1"
  echo "      найден существующий образ pauk-robot:latest"
elif docker image inspect lan-calendar-robot:latest >/dev/null 2>&1; then
  docker tag lan-calendar-robot:latest pauk-robot:latest
  HAS_ROBOT_IMAGE="1"
  echo "      переиспользован образ с Chromium lan-calendar-robot:latest -> pauk-robot:latest"
fi

echo "[3/6] Подготавливаю директорию $TARGET и файлы проекта…"
mkdir -p "$TARGET/docker" "$TARGET/data/robot" "$TARGET/backups" "$TARGET/robot"

cp "$HERE/docker/Dockerfile" "$TARGET/docker/Dockerfile"
cp "$HERE/docker/Dockerfile.caddy" "$TARGET/docker/Dockerfile.caddy"
cp "$HERE/docker/caddy-entrypoint.sh" "$TARGET/docker/caddy-entrypoint.sh"
cp "$HERE/docker/Caddyfile.pauk" "$TARGET/docker/Caddyfile.pauk"
cp "$HERE/docker/docker-compose.pauk.yml" "$TARGET/docker/docker-compose.pauk.yml"
chmod +x "$TARGET/docker/caddy-entrypoint.sh"

if [ -d "$HERE/robot" ]; then
  cp "$HERE/robot"/* "$TARGET/robot/"
fi

echo "[4/6] Копирую базу данных, ключи шифрования и настройки со старой версии…"
BASELINE_COUNTS=""

# Если в /opt/pauk уже есть своя БД — сбрасываем WAL в основной файл и делаем бэкап перед обновлением.
if [ -f "$TARGET/data/calendar.db" ]; then
  if st_container_running pauk-app; then
    docker exec -i pauk-app node --no-warnings -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync("/app/data/calendar.db");
      for (const fn of ["lc_dec_pfn", "lc_dec_pph", "lc_dec_plg", "lc_dec_ppw"]) {
        db.function(fn, { deterministic: true }, (v) => v ?? "");
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      db.close();
    ' >/dev/null 2>&1 || true
    BASELINE_COUNTS="$(st_pauk_counts)"
  else
    BASELINE_COUNTS="$(st_db_counts_file "$TARGET/data/calendar.db")"
  fi
  cp "$TARGET/data/calendar.db" "$TARGET/backups/before-update-$STAMP.db"
  echo "      сохранена резервная копия текущей БД: $TARGET/backups/before-update-$STAMP.db"
fi

# Если это первая установка в /opt/pauk (или указан --copy-db) и найдена старая база в /opt/lan_calendar:
if { [ ! -f "$TARGET/data/calendar.db" ] || [ -n "$FORCE_COPY_DB" ]; } && [ -f "$SOURCE_OLD/data/calendar.db" ]; then
  echo "      найдена база старой версии: $SOURCE_OLD/data/calendar.db"
  BASELINE_COUNTS="$(st_db_counts_file "$SOURCE_OLD/data/calendar.db")"

  # Копируем основной файл БД и журналы WAL/SHM (чтобы не потерять незафиксированные транзакции живого сервера)
  cp -f "$SOURCE_OLD/data/calendar.db" "$TARGET/data/calendar.db"
  [ -f "$SOURCE_OLD/data/calendar.db-wal" ] && cp -f "$SOURCE_OLD/data/calendar.db-wal" "$TARGET/data/calendar.db-wal" || rm -f "$TARGET/data/calendar.db-wal"
  [ -f "$SOURCE_OLD/data/calendar.db-shm" ] && cp -f "$SOURCE_OLD/data/calendar.db-shm" "$TARGET/data/calendar.db-shm" || rm -f "$TARGET/data/calendar.db-shm"

  # Сразу фиксируем WAL-журнал и адаптируем вычисляемые столбцы старой версии (lc_dec_*) в скопированной базе
  docker run --rm -v "$TARGET/data:/data" pauk:latest node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/data/calendar.db");
    for (const fn of ["lc_dec_pfn", "lc_dec_pph", "lc_dec_plg", "lc_dec_ppw"]) {
      db.function(fn, { deterministic: true }, (v) => v ?? "");
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    for (const [table, col] of [["people", "full_name"], ["people", "phone"], ["points", "login"], ["points", "password"]]) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = \x27table\x27 AND name = ?").get(table);
      if (!exists) continue;
      const xinfo = db.prepare("PRAGMA table_xinfo(" + table + ")").all();
      const names = new Set(xinfo.map((r) => r.name));
      if (names.has(col + "_enc")) {
        if (names.has(col)) db.exec("ALTER TABLE " + table + " DROP COLUMN " + col);
        db.exec("ALTER TABLE " + table + " RENAME COLUMN " + col + "_enc TO " + col);
      }
    }
    db.close();
  ' >/dev/null 2>&1 || true

  cp -f "$TARGET/data/calendar.db" "$TARGET/backups/copied-from-old-$STAMP.db"
  echo "      база данных скопирована и проверена (снимок: backups/copied-from-old-$STAMP.db)"
fi

# Копируем ключи шифрования (.field_key, .secret_key, .bot_api_key, .robot_api_key),
# чтобы зашифрованные ФИО, телефоны и пароли комплексов из старой базы открывались без ошибок.
if [ -d "$SOURCE_OLD/data" ]; then
  for k in .field_key .secret_key .bot_api_key; do
    if [ -f "$SOURCE_OLD/data/$k" ] && [ ! -f "$TARGET/data/$k" ]; then
      cp -p "$SOURCE_OLD/data/$k" "$TARGET/data/$k"
      echo "      скопирован ключ $k"
    fi
  done
  if [ -f "$SOURCE_OLD/data/robot/.robot_api_key" ] && [ ! -f "$TARGET/data/robot/.robot_api_key" ]; then
    cp -p "$SOURCE_OLD/data/robot/.robot_api_key" "$TARGET/data/robot/.robot_api_key"
    echo "      скопирован ключ робота .robot_api_key"
  fi

  # Копируем вложения (шаблоны отчётов, файлы карточек АПК, локальные фото, файлы чата) без перезаписи новых
  for sub in point_files report_templates visit_photos chat_files account_chat_files ai_files agent_models; do
    if [ -d "$SOURCE_OLD/data/$sub" ]; then
      mkdir -p "$TARGET/data/$sub"
      cp -rn "$SOURCE_OLD/data/$sub/." "$TARGET/data/$sub/" 2>/dev/null || cp -r "$SOURCE_OLD/data/$sub/." "$TARGET/data/$sub/" 2>/dev/null || true
    fi
  done
fi

# Формируем .env в /opt/pauk/.env (берём за основу старый .env, если он есть, и прописываем APP_NAME=Паук и отдельные порты)
if [ ! -f "$TARGET/.env" ]; then
  if [ -f "$SOURCE_OLD/.env" ]; then
    cp "$SOURCE_OLD/.env" "$TARGET/.env"
    echo "      скопирован .env из $SOURCE_OLD/.env"
  elif [ -f "$HERE/.env.example" ]; then
    cp "$HERE/.env.example" "$TARGET/.env"
  else
    touch "$TARGET/.env"
  fi
fi

set_env_var() {
  local file="$1" key="$2" val="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$file"
  fi
}

set_env_var "$TARGET/.env" "APP_NAME" "Паук"
set_env_var "$TARGET/.env" "PAUK_HTTPS_PORT" "$HTTPS_PORT"
set_env_var "$TARGET/.env" "PAUK_APP_PORT" "$APP_PORT"
set_env_var "$TARGET/.env" "COOKIE_NAME" "pauk_access_token"

# Копируем bot.env при наличии (для быстрого включения бота при необходимости)
if [ -f "$SOURCE_OLD/bot.env" ] && [ ! -f "$TARGET/bot.env" ]; then
  cp "$SOURCE_OLD/bot.env" "$TARGET/bot.env"
fi

chmod 600 "$TARGET/.env" "$TARGET/bot.env" 2>/dev/null || true
chmod 700 "$TARGET/data" "$TARGET/backups" 2>/dev/null || true
for f in "$TARGET"/data/.secret_key "$TARGET"/data/.bot_api_key "$TARGET"/data/.field_key "$TARGET"/data/robot/.robot_api_key; do
  [ -f "$f" ] && chmod 600 "$f"
done

echo "[5/6] Запускаю контейнеры «Паук» (проект compose: pauk)…"
cd "$TARGET/docker"

PROFILES=()
if [ -n "$HAS_ROBOT_IMAGE" ]; then
  PROFILES+=(--profile robot)
  # Если профиль браузера Яндекса уже был авторизован в старом томе docker_robot_profile — скопируем сессию в pauk_robot_profile при первом создании
  if docker volume inspect docker_robot_profile >/dev/null 2>&1 && ! docker volume inspect pauk_pauk_robot_profile >/dev/null 2>&1; then
    docker volume create pauk_pauk_robot_profile >/dev/null 2>&1 || true
    docker run --rm -v docker_robot_profile:/from:ro -v pauk_pauk_robot_profile:/to pauk:latest sh -c 'cp -a /from/. /to/ 2>/dev/null || true' || true
    echo "      перенесена авторизация браузера Яндекс из старого тома"
  fi
fi

if [ -n "$WITH_BOT" ]; then
  PROFILES+=(--profile bot)
fi

docker compose -p pauk -f docker-compose.pauk.yml "${PROFILES[@]}" up -d --no-build --force-recreate

echo "      жду готовности «Паук» (до 60 с)…"
for _ in $(seq 1 30); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' pauk-app 2>/dev/null || echo starting)" = "healthy" ]; then
    break
  fi
  sleep 2
done

echo "[6/6] Выполняю самопроверку…"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'NAMES|pauk|lan-calendar|codd-bot|yandex-robot' || true

RESULT=0
st_selftest_pauk "$TARGET" "$HTTPS_PORT" "$APP_PORT" "$BASELINE_COUNTS" "$OLD_RUNNING"
st_report || RESULT=1

SERVER_IP="$(grep -E '^SERVER_ADDRESS=' "$TARGET/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]' || true)"
[ -z "$SERVER_IP" ] && SERVER_IP="<IP_СЕРВЕРА>"

echo "=================================================================="
echo " Готово! Новая система «Паук» работает параллельно со старой:"
echo "   • Старая система : https://${SERVER_IP}/ (порты 80/443 без изменений)"
echo "   • Новая «Паук»   : https://${SERVER_IP}:${HTTPS_PORT}/"
echo "   • Сертификат CA  : https://${SERVER_IP}:${HTTPS_PORT}/ca.crt"
echo "   • Папка «Паук»   : $TARGET"
echo "=================================================================="
exit "$RESULT"
