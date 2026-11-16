# Универсальный сборщик офлайн-архивов для Windows PowerShell (БЕЗ WSL и без Git Bash):
#   powershell -ExecutionPolicy Bypass -File .\scripts\offline\make_bundle.ps1 [pauk|pauk-app|app|robot|all] [папка_вывода]
#
# Режимы:
#   pauk     — полный архив «Паук» для параллельной установки в /opt/pauk на порт 8443 (Node.js + Caddy + Chromium)
#   pauk-app — быстрый архив обновления «Паук» (Node.js + Caddy, без переупаковки Chromium)
#   app      — обновление существующей установки lan-calendar (/opt/lan_calendar)
#   robot    — отдельный архив робота Яндекс (образ с Chromium)
#   all      — app + robot

param(
    [Parameter(Position = 0)]
    [string]$What = "pauk",

    [Parameter(Position = 1)]
    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $RepoRoot "offline-out"
}
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}
$OutDir = (Resolve-Path $OutDir).Path

# Если выбран режим pauk / pauk-full / pauk-app — передаём управление make_pauk_bundle.ps1
switch ($What.ToLower()) {
    "pauk" {
        & (Join-Path $PSScriptRoot "make_pauk_bundle.ps1") -Mode "full" -OutDir $OutDir
        exit $LASTEXITCODE
    }
    "pauk-full" {
        & (Join-Path $PSScriptRoot "make_pauk_bundle.ps1") -Mode "full" -OutDir $OutDir
        exit $LASTEXITCODE
    }
    "pauk-app" {
        & (Join-Path $PSScriptRoot "make_pauk_bundle.ps1") -Mode "app" -OutDir $OutDir
        exit $LASTEXITCODE
    }
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker не запущен или недоступен. Запустите Docker Desktop и повторите попытку."
    exit 1
}

$Stamp = Get-Date -Format "yyyyMMdd"
$AppStamp = Get-Date -Format "yyyyMMdd-HHmm"
$RobotVersion = Get-Date -Format "yyyyMMddHHmmss"

function Build-AppBundle {
    $B = Join-Path $OutDir "lan-calendar-app"
    if (Test-Path $B) { Remove-Item -Path $B -Recurse -Force }
    New-Item -ItemType Directory -Path (Join-Path $B "docker") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $B "robot") -Force | Out-Null

    Write-Host "[приложение 1/3] Собираю образ lan-calendar:latest..." -ForegroundColor Cyan
    docker build -f docker/Dockerfile -t lan-calendar:latest .
    if ($LASTEXITCODE -ne 0) { throw "Ошибка сборки lan-calendar:latest" }

    Write-Host "[приложение 2/3] Сохраняю образ..." -ForegroundColor Cyan
    docker save -o (Join-Path $B "lan-calendar.tar") lan-calendar:latest
    if ($LASTEXITCODE -ne 0) { throw "Ошибка сохранения lan-calendar.tar" }

    Write-Host "[приложение 3/3] Комплектую файлы и собираю архив..." -ForegroundColor Cyan
    foreach ($f in @("Dockerfile","Dockerfile.caddy","Caddyfile","caddy-entrypoint.sh","docker-compose.yml","docker-compose.local.yml")) {
        Copy-Item (Join-Path $RepoRoot "docker\$f") (Join-Path $B "docker\$f") -Force
    }
    foreach ($f in @("Dockerfile","requirements.txt","server.py","constructor.py","forms.py","pagewait.py","README.md")) {
        Copy-Item (Join-Path $RepoRoot "robot\$f") (Join-Path $B "robot\$f") -Force
    }
    Copy-Item (Join-Path $RepoRoot "scripts\offline\install_app.sh") (Join-Path $B "install.sh") -Force
    Copy-Item (Join-Path $RepoRoot "scripts\offline\selftest.sh") (Join-Path $B "selftest.sh") -Force
    Copy-Item (Join-Path $RepoRoot "scripts\offline\README_app.txt") (Join-Path $B "README.txt") -Force

    $ArchiveName = "lan-calendar-app-$AppStamp.tar"
    $LinuxCmd = @"
set -eu
B=/out/lan-calendar-app
echo '$RobotVersion' > "`$B/robot/VERSION"
echo '$AppStamp' > "`$B/BUILD"
for f in "`$B/install.sh" "`$B/selftest.sh" "`$B/README.txt" "`$B"/docker/* "`$B"/robot/*; do
  if [ -f "`$f" ]; then sed -i 's/\r$//' "`$f"; fi
done
chmod +x "`$B/install.sh" "`$B/selftest.sh" "`$B/docker/caddy-entrypoint.sh"
gzip -3 -f "`$B/lan-calendar.tar"
cd /app
find server bot static templates -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "`$B/CODE.sha256"
sha256sum server.ts package.json tsconfig.json >> "`$B/CODE.sha256"
cd "`$B"
sha256sum lan-calendar.tar.gz docker/* robot/* selftest.sh install.sh BUILD CODE.sha256 > SHA256SUMS
tar -C /out -cf "/out/$ArchiveName" lan-calendar-app
"@
    $LinuxCmdClean = $LinuxCmd -replace "`r", ""
    docker run --rm -v "${OutDir}:/out" lan-calendar:latest sh -c $LinuxCmdClean
    if ($LASTEXITCODE -ne 0) { throw "Ошибка упаковки $ArchiveName" }
    Write-Host "Готово: $(Join-Path $OutDir $ArchiveName)" -ForegroundColor Green
}

function Build-RobotBundle {
    $B = Join-Path $OutDir "yandex-robot"
    if (Test-Path $B) { Remove-Item -Path $B -Recurse -Force }
    New-Item -ItemType Directory -Path (Join-Path $B "robot") -Force | Out-Null

    Write-Host "[робот 1/3] Собираю образ lan-calendar-robot:latest (с браузером Chromium)..." -ForegroundColor Cyan
    docker build -t lan-calendar-robot:latest robot
    if ($LASTEXITCODE -ne 0) { throw "Ошибка сборки lan-calendar-robot:latest" }

    Write-Host "[робот 2/3] Сохраняю образ..." -ForegroundColor Cyan
    docker save -o (Join-Path $B "yandex-robot.tar") lan-calendar-robot:latest
    if ($LASTEXITCODE -ne 0) { throw "Ошибка сохранения yandex-robot.tar" }

    Write-Host "[робот 3/3] Собираю архив..." -ForegroundColor Cyan
    foreach ($f in @("Dockerfile","requirements.txt","server.py","constructor.py","forms.py","pagewait.py","README.md")) {
        Copy-Item (Join-Path $RepoRoot "robot\$f") (Join-Path $B "robot\$f") -Force
    }
    Copy-Item (Join-Path $RepoRoot "docker\docker-compose.yml") (Join-Path $B "docker-compose.yml") -Force
    Copy-Item (Join-Path $RepoRoot "scripts\offline\install_robot.sh") (Join-Path $B "install.sh") -Force
    Copy-Item (Join-Path $RepoRoot "scripts\offline\selftest.sh") (Join-Path $B "selftest.sh") -Force
    Copy-Item (Join-Path $RepoRoot "scripts\offline\README_robot.txt") (Join-Path $B "README.txt") -Force

    $ArchiveName = "yandex-robot-$Stamp.tar"
    $LinuxCmd = @"
set -eu
B=/out/yandex-robot
echo '$RobotVersion' > "`$B/robot/VERSION"
for f in "`$B/install.sh" "`$B/selftest.sh" "`$B/README.txt" "`$B/docker-compose.yml" "`$B"/robot/*; do
  if [ -f "`$f" ]; then sed -i 's/\r$//' "`$f"; fi
done
chmod +x "`$B/install.sh" "`$B/selftest.sh"
gzip -3 -f "`$B/yandex-robot.tar"
cd "`$B"
sha256sum yandex-robot.tar.gz docker-compose.yml selftest.sh install.sh > SHA256SUMS
tar -C /out -cf "/out/$ArchiveName" yandex-robot
"@
    $LinuxCmdClean = $LinuxCmd -replace "`r", ""
    docker run --rm -v "${OutDir}:/out" lan-calendar-robot:latest sh -c $LinuxCmdClean
    if ($LASTEXITCODE -ne 0) { throw "Ошибка упаковки $ArchiveName" }
    Write-Host "Готово: $(Join-Path $OutDir $ArchiveName)" -ForegroundColor Green
}

switch ($What.ToLower()) {
    "app"   { Build-AppBundle }
    "robot" { Build-RobotBundle }
    "all"   { Build-AppBundle; Build-RobotBundle }
    default {
        Write-Host "Использование: .\make_bundle.cmd [pauk|pauk-app|app|robot|all] [папка_вывода]" -ForegroundColor Yellow
        exit 1
    }
}
