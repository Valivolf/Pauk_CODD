# Universal offline bundle builder for Windows PowerShell 5.1 / 7+ (pure ASCII for encoding safety)
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\offline\make_bundle.ps1 [pauk|pauk-app|app|robot|all] [output_dir]

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
    Write-Error "Docker is not running. Please start Docker Desktop and try again."
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

    Write-Host "[app 1/3] Building image lan-calendar:latest..." -ForegroundColor Cyan
    docker build -f docker/Dockerfile -t lan-calendar:latest .
    if ($LASTEXITCODE -ne 0) { throw "Failed to build lan-calendar:latest" }

    Write-Host "[app 2/3] Saving image..." -ForegroundColor Cyan
    docker save -o (Join-Path $B "lan-calendar.tar") lan-calendar:latest
    if ($LASTEXITCODE -ne 0) { throw "Failed to save lan-calendar.tar" }

    Write-Host "[app 3/3] Packaging archive..." -ForegroundColor Cyan
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
    if ($LASTEXITCODE -ne 0) { throw "Failed to package $ArchiveName" }
    Write-Host "Ready: $(Join-Path $OutDir $ArchiveName)" -ForegroundColor Green
}

function Build-RobotBundle {
    $B = Join-Path $OutDir "yandex-robot"
    if (Test-Path $B) { Remove-Item -Path $B -Recurse -Force }
    New-Item -ItemType Directory -Path (Join-Path $B "robot") -Force | Out-Null

    Write-Host "[robot 1/3] Building image lan-calendar-robot:latest (with Chromium)..." -ForegroundColor Cyan
    docker build -t lan-calendar-robot:latest robot
    if ($LASTEXITCODE -ne 0) { throw "Failed to build lan-calendar-robot:latest" }

    Write-Host "[robot 2/3] Saving image..." -ForegroundColor Cyan
    docker save -o (Join-Path $B "yandex-robot.tar") lan-calendar-robot:latest
    if ($LASTEXITCODE -ne 0) { throw "Failed to save yandex-robot.tar" }

    Write-Host "[robot 3/3] Packaging archive..." -ForegroundColor Cyan
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
    if ($LASTEXITCODE -ne 0) { throw "Failed to package $ArchiveName" }
    Write-Host "Ready: $(Join-Path $OutDir $ArchiveName)" -ForegroundColor Green
}

switch ($What.ToLower()) {
    "app"   { Build-AppBundle }
    "robot" { Build-RobotBundle }
    "all"   { Build-AppBundle; Build-RobotBundle }
    default {
        Write-Host "Usage: .\make_bundle.cmd [pauk|pauk-app|app|robot|all] [output_dir]" -ForegroundColor Yellow
        exit 1
    }
}
