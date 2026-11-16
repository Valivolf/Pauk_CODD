#!/usr/bin/env bash
# Собирает архивы для установки на сервер БЕЗ интернета (на ноутбуке/ВМ с интернетом):
#     bash scripts/offline/make_bundle.sh [app|robot|all] [куда_положить]
#   app    — lan-calendar-app-<дата-время>.tar : приложение (образ Node.js + файлы из docker/ + код робота).
#   robot  — yandex-robot-<дата>.tar       : робот карт (образ с Chromium). Возится один раз.
#   all    — приложение + робот (по умолчанию).
set -euo pipefail
cd "$(dirname "$0")/../.."

WHAT="${1:-all}"
OUT="${2:-$PWD/offline-out}"
STAMP="$(date +%Y%m%d)"
APP_STAMP="$(date +%Y%m%d-%H%M)"
ROBOT_VERSION="$(date +%Y%m%d%H%M%S)"
mkdir -p "$OUT"

make_app() {
  local B="$OUT/lan-calendar-app"
  rm -rf "$B"
  mkdir -p "$B/docker" "$B/robot"

  echo "[приложение 1/3] собираю образ lan-calendar:latest…"
  docker build -q -f docker/Dockerfile -t lan-calendar:latest .

  echo "[приложение 2/3] сохраняю образ…"
  docker save lan-calendar:latest | gzip -3 > "$B/lan-calendar.tar.gz"

  echo "[приложение 3/3] собираю архив…"
  cp docker/Dockerfile docker/Dockerfile.caddy docker/Caddyfile docker/caddy-entrypoint.sh docker/docker-compose.yml docker/docker-compose.local.yml "$B/docker/"
  cp robot/Dockerfile robot/requirements.txt robot/server.py robot/constructor.py robot/forms.py robot/pagewait.py robot/README.md "$B/robot/"
  echo "$ROBOT_VERSION" > "$B/robot/VERSION"
  cp scripts/offline/install_app.sh "$B/install.sh"
  cp scripts/offline/selftest.sh "$B/selftest.sh"
  cp scripts/offline/README_app.txt "$B/README.txt"
  chmod +x "$B/install.sh" "$B/selftest.sh"

  echo "$APP_STAMP" > "$B/BUILD"
  find server bot static templates -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "$B/CODE.sha256"
  sha256sum server.ts package.json tsconfig.json >> "$B/CODE.sha256"
  (cd "$B" && sha256sum lan-calendar.tar.gz docker/* robot/* selftest.sh install.sh BUILD CODE.sha256 > SHA256SUMS)

  tar -C "$OUT" -cf "$OUT/lan-calendar-app-$APP_STAMP.tar" lan-calendar-app
  ls -lh "$OUT/lan-calendar-app-$APP_STAMP.tar"
}

make_robot() {
  local B="$OUT/yandex-robot"
  rm -rf "$B"
  mkdir -p "$B/robot"

  echo "[робот 1/3] собираю образ lan-calendar-robot:latest (скачивает браузер, если образа ещё нет)…"
  docker build -q -t lan-calendar-robot:latest robot

  echo "[робот 2/3] сохраняю образ…"
  docker save lan-calendar-robot:latest | gzip -3 > "$B/yandex-robot.tar.gz"

  echo "[робот 3/3] собираю архив…"
  cp robot/Dockerfile robot/requirements.txt robot/server.py robot/constructor.py robot/forms.py robot/pagewait.py robot/README.md "$B/robot/"
  echo "$ROBOT_VERSION" > "$B/robot/VERSION"
  cp docker/docker-compose.yml "$B/docker-compose.yml"
  cp scripts/offline/install_robot.sh "$B/install.sh"
  cp scripts/offline/selftest.sh "$B/selftest.sh"
  cp scripts/offline/README_robot.txt "$B/README.txt"
  chmod +x "$B/install.sh" "$B/selftest.sh"
  (cd "$B" && sha256sum yandex-robot.tar.gz docker-compose.yml selftest.sh install.sh > SHA256SUMS)

  tar -C "$OUT" -cf "$OUT/yandex-robot-$STAMP.tar" yandex-robot
  ls -lh "$OUT/yandex-robot-$STAMP.tar"
}

case "$WHAT" in
  app) make_app ;;
  robot) make_robot ;;
  all) make_app; make_robot ;;
  pauk|pauk-full) exec bash "$PWD/scripts/offline/make_pauk_bundle.sh" full "$OUT" ;;
  pauk-app) exec bash "$PWD/scripts/offline/make_pauk_bundle.sh" app "$OUT" ;;
  *) echo "Использование: make_bundle.sh [app|robot|all|pauk|pauk-app] [папка]"; exit 1 ;;
esac

echo "Готово: $OUT"
