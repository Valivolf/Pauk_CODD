#!/usr/bin/env bash
# Отдельный сборщик офлайн-дистрибутива «Паук» для параллельной установки на рабочий сервер
# рядом со старой системой (в /opt/pauk на свой HTTPS-порт, например 8443, с копированием БД).
#
# Запуск на ноутбуке (с интернетом и Docker):
#   bash scripts/offline/make_pauk_bundle.sh [full|app] [папка_вывода]
#
# Режимы:
#   full (по умолчанию) — полный архив для развёртывания с нуля на сервере без интернета:
#                         включает образ приложения (Node.js), образ HTTPS-прокси (Caddy + iproute2)
#                         И образ робота с уже установленным браузером Chromium внутри!
#   app                 — быстрый архив обновления: приложение + Caddy + скрипты (использует
#                         уже загруженный на сервере образ браузера pauk-robot / lan-calendar-robot).
set -euo pipefail
cd "$(dirname "$0")/../.."

MODE="${1:-full}"
OUT="${2:-$PWD/offline-out}"
APP_STAMP="$(date +%Y%m%d-%H%M)"
ROBOT_VERSION="$(date +%Y%m%d%H%M%S)"
mkdir -p "$OUT"

build_pauk_bundle() {
  local include_robot="$1"
  local pkg_prefix="$2"
  local B="$OUT/pauk-bundle"
  rm -rf "$B"
  mkdir -p "$B/docker" "$B/robot"

  echo "[Паук 1/5] Собираю образ приложения pauk:latest (Node.js + зависимости + iputils-ping)…"
  docker build -q -f docker/Dockerfile -t pauk:latest .
  docker tag pauk:latest lan-calendar:latest

  echo "[Паук 2/5] Сохраняю образ pauk:latest -> pauk.tar.gz…"
  docker save pauk:latest | gzip -3 > "$B/pauk.tar.gz"

  echo "[Паук 3/5] Собираю и сохраняю образ HTTPS-сервера pauk-caddy:latest (Caddy + iproute2)…"
  docker build -q -f docker/Dockerfile.caddy -t pauk-caddy:latest docker
  docker save pauk-caddy:latest | gzip -3 > "$B/pauk-caddy.tar.gz"

  if [ "$include_robot" = "1" ]; then
    echo "[Паук 4/5] Собираю и сохраняю образ pauk-robot:latest (Python + Playwright + браузер Chromium внутри)…"
    docker build -q -t pauk-robot:latest robot
    docker save pauk-robot:latest | gzip -3 > "$B/pauk-robot.tar.gz"
  else
    echo "[Паук 4/5] Режим 'app': пропускаю упаковку тяжёлого образа Chromium (на сервере будет использован уже установленный)…"
  fi

  echo "[Паук 5/5] Комплектую конфиги, скрипты миграции БД и контрольные суммы…"
  cp docker/Dockerfile docker/Dockerfile.caddy docker/Caddyfile docker/Caddyfile.pauk \
     docker/caddy-entrypoint.sh docker/docker-compose.yml docker/docker-compose.local.yml \
     docker/docker-compose.pauk.yml "$B/docker/"
  cp robot/Dockerfile robot/requirements.txt robot/server.py robot/constructor.py \
     robot/forms.py robot/pagewait.py robot/README.md "$B/robot/"
  echo "$ROBOT_VERSION" > "$B/robot/VERSION"
  cp .env.example "$B/.env.example"

  cp scripts/offline/install_pauk.sh "$B/install.sh"
  cp scripts/offline/install_pauk.sh "$B/install_pauk.sh"
  cp scripts/offline/selftest_pauk.sh "$B/selftest_pauk.sh"
  cp scripts/offline/README_pauk.txt "$B/README.txt"
  chmod +x "$B/install.sh" "$B/install_pauk.sh" "$B/selftest_pauk.sh" "$B/docker/caddy-entrypoint.sh"

  echo "$APP_STAMP" > "$B/BUILD"
  find server bot static templates -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "$B/CODE.sha256"
  sha256sum server.ts package.json tsconfig.json >> "$B/CODE.sha256"

  (
    cd "$B"
    if [ -f pauk-robot.tar.gz ]; then
      sha256sum pauk.tar.gz pauk-caddy.tar.gz pauk-robot.tar.gz .env.example docker/* robot/* selftest_pauk.sh install.sh BUILD CODE.sha256 > SHA256SUMS
    else
      sha256sum pauk.tar.gz pauk-caddy.tar.gz .env.example docker/* robot/* selftest_pauk.sh install.sh BUILD CODE.sha256 > SHA256SUMS
    fi
  )

  local archive="$OUT/${pkg_prefix}-${APP_STAMP}.tar"
  tar -C "$OUT" -cf "$archive" pauk-bundle
  ls -lh "$archive"
  echo
  echo "Готов офлайн-пакет «Паук»: $archive"
  echo "На рабочем сервере выполните:"
  echo "  tar xf $(basename "$archive") && cd pauk-bundle && sudo bash install.sh"
}

case "$MODE" in
  full) build_pauk_bundle "1" "pauk-full" ;;
  app)  build_pauk_bundle "0" "pauk-app" ;;
  *)
    echo "Использование: bash scripts/offline/make_pauk_bundle.sh [full|app] [папка_вывода]"
    exit 1
    ;;
esac
