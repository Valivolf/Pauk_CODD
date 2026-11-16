ОБНОВЛЕНИЕ ПРИЛОЖЕНИЯ «ПАУК» НА СЕРВЕРЕ БЕЗ ИНТЕРНЕТА (Node.js)
================================================================

(Для параллельной установки рядом со старой версией в /opt/pauk на отдельный порт 8443
см. README_pauk.txt и скрипт `bash scripts/offline/make_pauk_bundle.sh full`.)

1. На компьютере с интернетом (где есть Docker):
     bash scripts/offline/make_bundle.sh app
   В папке offline-out появится файл lan-calendar-app-<дата-время>.tar.
   (Если также нужен робот Яндекс.Карт: bash scripts/offline/make_bundle.sh all)

2. Локальный запуск для проверки на ноутбуке:
     docker compose -f docker/docker-compose.yml -f docker/docker-compose.local.yml up -d --build lan-calendar codd-bot
   Открыть в браузере: http://localhost:3000

3. На рабочем сервере без интернета:
     rm -rf ~/lan-calendar-app
     tar xf lan-calendar-app-ДАТА-ВРЕМЯ.tar
     cd lan-calendar-app
     sudo bash install.sh

Откат при необходимости:
  docker tag lan-calendar:previous lan-calendar:latest
  cd /opt/lan_calendar/docker && docker compose up -d --no-build lan-calendar codd-bot
