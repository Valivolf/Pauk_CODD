#!/usr/bin/env bash
# Установка робота Яндекс.Конструктора карт на сервер БЕЗ интернета (браузер уже внутри образа).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK_ONLY=""
if [ "${1:-}" = "--check" ]; then CHECK_ONLY=1; shift; fi
PROJECT="${1:-/opt/lan_calendar}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# shellcheck source=selftest.sh
. "$HERE/selftest.sh"

if [ ! -f "$PROJECT/docker/docker-compose.yml" ]; then
  echo "Не найдена папка проекта: $PROJECT (там должен быть docker/docker-compose.yml)."
  exit 1
fi
docker info >/dev/null 2>&1 || { echo "Нет доступа к Docker. Запустите с правами: sudo bash install.sh"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Не найден «docker compose» (нужен Compose v2)."; exit 1; }

if [ -n "$CHECK_ONLY" ]; then
  st_selftest_robot "$PROJECT"
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

echo "[1/4] Проверяю целостность файлов…"
(cd "$HERE" && sha256sum -c SHA256SUMS)

echo "[2/4] Загружаю образ робота в Docker…"
gunzip -c "$HERE/yandex-robot.tar.gz" | docker load

echo "[3/4] Файлы робота и compose…"
copy_robot_code
if ! grep -q 'yandex-robot' "$PROJECT/docker/docker-compose.yml"; then
  cp "$PROJECT/docker/docker-compose.yml" "$PROJECT/docker/docker-compose.yml.bak-$STAMP"
  cp "$HERE/docker-compose.yml" "$PROJECT/docker/docker-compose.yml"
fi

echo "[4/4] Запускаю робота…"
cd "$PROJECT/docker"
docker compose --profile robot up -d --no-build yandex-robot

echo "Жду запуска…"
for _ in $(seq 1 20); do
  if docker exec yandex-robot python -c "import urllib.request,sys;sys.exit(0 if b'true' in urllib.request.urlopen('http://127.0.0.1:8100/health',timeout=5).read() else 1)" 2>/dev/null; then
    break
  fi
  sleep 2
done
echo

docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'NAMES|lan-calendar|yandex-robot' || true

RESULT=0
st_selftest_robot "$PROJECT"
st_report || RESULT=1
exit "$RESULT"
