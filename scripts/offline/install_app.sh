#!/usr/bin/env bash
# Установка обновления приложения «Паук» на сервер БЕЗ интернета.
#     cd lan-calendar-app && sudo bash install.sh [папка_проекта]
# По умолчанию папка проекта — /opt/lan_calendar (там docker/, data/, backups/).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK_ONLY=""
if [ "${1:-}" = "--check" ]; then CHECK_ONLY=1; shift; fi
PROJECT="${1:-/opt/lan_calendar}"
STAMP="$(date +%Y%m%d-%H%M%S)"
SINCE="$(date +%s)"

# shellcheck source=selftest.sh
. "$HERE/selftest.sh"

echo "Сборка пакета: $(cat "$HERE/BUILD" 2>/dev/null || echo 'не указана')"

if [ ! -f "$PROJECT/docker/docker-compose.yml" ]; then
  echo "Не найдена папка проекта: $PROJECT (там должен быть docker/docker-compose.yml)."
  echo "Если проект лежит в другом месте: sudo bash install.sh /путь/к/проекту"
  exit 1
fi

docker info >/dev/null 2>&1 || { echo "Нет доступа к Docker. Запустите с правами: sudo bash install.sh"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Не найден «docker compose» (нужен Compose v2)."; exit 1; }

set_host_timezone() {
  command -v timedatectl >/dev/null 2>&1 || return 0
  local cur
  cur="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  if [ -n "$cur" ] && [ "$cur" != "Europe/Moscow" ]; then
    timedatectl set-timezone Europe/Moscow >/dev/null 2>&1 \
      && echo "Часовой пояс сервера: $cur -> Europe/Moscow." \
      || true
  fi
}

if [ -n "$CHECK_ONLY" ]; then
  st_selftest_app "$PROJECT" "$(( $(date +%s) - 900 ))" "" ""
  st_report
  exit $?
fi

copy_robot_code() {
  local src="$HERE/robot" dst="$PROJECT/robot"
  [ -d "$src" ] || return 0
  mkdir -p "$dst" "$PROJECT/data/robot"
  local new cur
  new="$(cat "$src/VERSION" 2>/dev/null || echo 0)"
  cur="$(cat "$dst/VERSION" 2>/dev/null || echo 0)"
  if [[ "$new" < "$cur" ]]; then
    echo "      код робота в проекте новее ($cur) — оставляю его"
  else
    cp "$src"/* "$dst/"
  fi
}

set_host_timezone

echo "[1/5] Проверяю целостность файлов…"
(cd "$HERE" && sha256sum -c SHA256SUMS)

echo "[2/5] Копия базы на случай отката…"
BACKUP=""
if [ -f "$PROJECT/data/calendar.db" ]; then
  mkdir -p "$PROJECT/backups"
  cp "$PROJECT/data/calendar.db" "$PROJECT/backups/before-update-$STAMP.db"
  BACKUP="$PROJECT/backups/before-update-$STAMP.db"
  echo "      backups/before-update-$STAMP.db"
fi

BEFORE="$(st_snapshot_counts)"

echo "[3/5] Загружаю образ приложения в Docker…"
docker tag lan-calendar:latest lan-calendar:previous 2>/dev/null || true
gunzip -c "$HERE/lan-calendar.tar.gz" | docker load
echo "      образ lan-calendar:latest загружен"

echo "[4/5] Обновляю файлы в папке docker/…"
caddy_changed=""
caddyfile_changed=""
for f in "$HERE"/docker/*; do
  name="$(basename "$f")"
  dst="$PROJECT/docker/$name"
  if [ -f "$dst" ] && ! cmp -s "$f" "$dst"; then
    cp "$dst" "$dst.bak-$STAMP"
    case "$name" in
      Caddyfile) caddyfile_changed=1 ;;
      Dockerfile.caddy|caddy-entrypoint.sh) caddy_changed=1 ;;
    esac
  fi
  cp "$f" "$dst"
done
copy_robot_code

harden_permissions() {
  local f
  for f in "$PROJECT/.env" "$PROJECT/bot.env"; do [ -f "$f" ] && chmod 600 "$f"; done
  chmod 700 "$PROJECT/data" "$PROJECT/backups" 2>/dev/null || true
  for f in "$PROJECT"/data/.secret_key "$PROJECT"/data/.bot_api_key "$PROJECT"/data/.field_key "$PROJECT"/data/robot/.robot_api_key; do
    [ -f "$f" ] && chmod 600 "$f"
  done
  find "$PROJECT/backups" "$PROJECT/data" -maxdepth 1 -type f \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' \) -exec chmod 600 {} + 2>/dev/null || true
}
harden_permissions

echo "[5/5] Запускаю приложение и бота на новом образе…"
cd "$PROJECT/docker"
docker compose up -d --no-build lan-calendar codd-bot

want_image="$(docker image inspect lan-calendar:latest --format '{{.Id}}' 2>/dev/null || true)"
for cname in lan-calendar codd-bot; do
  have_image="$(docker inspect "$cname" --format '{{.Image}}' 2>/dev/null || true)"
  if [ -n "$want_image" ] && [ "$have_image" != "$want_image" ]; then
    echo "      $cname остался на старом образе — пересоздаю принудительно…"
    docker compose up -d --force-recreate --no-build "$cname"
  fi
done

if [ -n "$caddyfile_changed" ] && docker ps --format '{{.Names}}' | grep -qx lan-calendar-caddy; then
  docker exec lan-calendar-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
    && echo "      настройки Caddy применены (без остановки)" \
    || echo "      перезапустите Caddy вручную: sudo docker restart lan-calendar-caddy"
fi

if docker ps -a --format '{{.Names}}' | grep -qx yandex-robot; then
  echo "      обновляю код робота карт…"
  docker compose --profile robot up -d --no-build yandex-robot
  docker restart yandex-robot >/dev/null
fi

echo "Жду запуска…"
for _ in $(seq 1 30); do
  if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login 2>/dev/null | grep -q 200; then
    break
  fi
  sleep 2
done
echo

docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'NAMES|lan-calendar|codd-bot|yandex-robot|caddy' || true

if [ -n "$caddy_changed" ]; then
  echo "Примечание: Dockerfile.caddy / caddy-entrypoint.sh отличаются от установленных — Caddy не пересобирался."
fi

RESULT=0
st_selftest_app "$PROJECT" "$SINCE" "$BEFORE" "$BACKUP"
st_report || RESULT=1
if [ "$RESULT" != "0" ]; then
  cat <<EOT
Откат к прежней версии:
  docker tag lan-calendar:previous lan-calendar:latest && cd $PROJECT/docker && docker compose up -d --no-build lan-calendar codd-bot
EOT
fi
exit "$RESULT"
