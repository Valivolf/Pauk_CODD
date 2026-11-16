# Offline bundle builder for Pauk (Windows PowerShell 5.1 / 7+, pure ASCII for encoding safety)
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\offline\make_pauk_bundle.ps1 full
#   powershell -ExecutionPolicy Bypass -File .\scripts\offline\make_pauk_bundle.ps1 app

param(
    [Parameter(Position = 0)]
    [string]$Mode = "full",

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

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker is not running. Please start Docker Desktop and try again."
    exit 1
}

$AppStamp = Get-Date -Format "yyyyMMdd-HHmm"
$RobotVersion = Get-Date -Format "yyyyMMddHHmmss"

function Build-PaukBundle {
    param(
        [bool]$IncludeRobot,
        [string]$PkgPrefix
    )

    $BundleDir = Join-Path $OutDir "pauk-bundle"
    if (Test-Path $BundleDir) {
        Remove-Item -Path $BundleDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Join-Path $BundleDir "docker") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $BundleDir "robot") -Force | Out-Null

    Write-Host "[Pauk 1/5] Building app image pauk:latest (Node.js + deps + iputils-ping)..." -ForegroundColor Cyan
    docker build -f docker/Dockerfile -t pauk:latest .
    if ($LASTEXITCODE -ne 0) { throw "Failed to build pauk:latest" }
    docker tag pauk:latest lan-calendar:latest

    Write-Host "[Pauk 2/5] Saving image pauk:latest -> pauk.tar..." -ForegroundColor Cyan
    docker save -o (Join-Path $BundleDir "pauk.tar") pauk:latest
    if ($LASTEXITCODE -ne 0) { throw "Failed to save pauk.tar" }

    Write-Host "[Pauk 3/5] Building and saving HTTPS proxy image pauk-caddy:latest (Caddy + iproute2)..." -ForegroundColor Cyan
    docker build -f docker/Dockerfile.caddy -t pauk-caddy:latest docker
    if ($LASTEXITCODE -ne 0) { throw "Failed to build pauk-caddy:latest" }
    docker save -o (Join-Path $BundleDir "pauk-caddy.tar") pauk-caddy:latest
    if ($LASTEXITCODE -ne 0) { throw "Failed to save pauk-caddy.tar" }

    if ($IncludeRobot) {
        Write-Host "[Pauk 4/5] Building and saving browser robot image pauk-robot:latest (Python + Playwright + Chromium)..." -ForegroundColor Cyan
        docker build -t pauk-robot:latest robot
        if ($LASTEXITCODE -ne 0) { throw "Failed to build pauk-robot:latest" }
        docker save -o (Join-Path $BundleDir "pauk-robot.tar") pauk-robot:latest
        if ($LASTEXITCODE -ne 0) { throw "Failed to save pauk-robot.tar" }
    } else {
        Write-Host "[Pauk 4/5] Mode 'app': skipping Chromium image build (will reuse existing image on server)..." -ForegroundColor Yellow
    }

    Write-Host "[Pauk 5/5] Copying configs, compressing images, normalizing LF line endings, and computing SHA256..." -ForegroundColor Cyan

    $DockerFiles = @(
        "Dockerfile",
        "Dockerfile.caddy",
        "Caddyfile",
        "Caddyfile.pauk",
        "caddy-entrypoint.sh",
        "docker-compose.yml",
        "docker-compose.local.yml",
        "docker-compose.pauk.yml"
    )
    foreach ($f in $DockerFiles) {
        Copy-Item (Join-Path $RepoRoot "docker\$f") (Join-Path $BundleDir "docker\$f") -Force
    }

    $RobotFiles = @(
        "Dockerfile",
        "requirements.txt",
        "server.py",
        "constructor.py",
        "forms.py",
        "pagewait.py",
        "README.md"
    )
    foreach ($f in $RobotFiles) {
        Copy-Item (Join-Path $RepoRoot "robot\$f") (Join-Path $BundleDir "robot\$f") -Force
    }

    Copy-Item (Join-Path $RepoRoot ".env.example") (Join-Path $BundleDir ".env.example") -Force
    Copy-Item (Join-Path $RepoRoot "scripts\offline\install_pauk.sh") (Join-Path $BundleDir "install.sh") -Force
    Copy-Item (Join-Path $RepoRoot "scripts\offline\install_pauk.sh") (Join-Path $BundleDir "install_pauk.sh") -Force
    Copy-Item (Join-Path $RepoRoot "scripts\offline\selftest_pauk.sh") (Join-Path $BundleDir "selftest_pauk.sh") -Force
    Copy-Item (Join-Path $RepoRoot "scripts\offline\README_pauk.txt") (Join-Path $BundleDir "README.txt") -Force

    $ArchiveName = "${PkgPrefix}-${AppStamp}.tar"
    $ArchivePath = Join-Path $OutDir $ArchiveName

    $LinuxFinalize = @"
set -eu
B=/out/pauk-bundle
echo '$RobotVersion' > "`$B/robot/VERSION"
echo '$AppStamp' > "`$B/BUILD"

for f in "`$B/install.sh" "`$B/install_pauk.sh" "`$B/selftest_pauk.sh" "`$B/.env.example" "`$B/README.txt" "`$B"/docker/* "`$B"/robot/*; do
  if [ -f "`$f" ]; then
    sed -i 's/\r$//' "`$f"
  fi
done
chmod +x "`$B/install.sh" "`$B/install_pauk.sh" "`$B/selftest_pauk.sh" "`$B/docker/caddy-entrypoint.sh"

gzip -3 -f "`$B/pauk.tar"
gzip -3 -f "`$B/pauk-caddy.tar"
if [ -f "`$B/pauk-robot.tar" ]; then
  gzip -3 -f "`$B/pauk-robot.tar"
fi

cd /app
find server bot static templates -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "`$B/CODE.sha256"
sha256sum server.ts package.json tsconfig.json >> "`$B/CODE.sha256"

cd "`$B"
if [ -f pauk-robot.tar.gz ]; then
  sha256sum pauk.tar.gz pauk-caddy.tar.gz pauk-robot.tar.gz .env.example docker/* robot/* selftest_pauk.sh install.sh BUILD CODE.sha256 > SHA256SUMS
else
  sha256sum pauk.tar.gz pauk-caddy.tar.gz .env.example docker/* robot/* selftest_pauk.sh install.sh BUILD CODE.sha256 > SHA256SUMS
fi

tar -C /out -cf "/out/$ArchiveName" pauk-bundle
"@

    $LinuxFinalizeClean = $LinuxFinalize -replace "`r", ""
    docker run --rm -v "${OutDir}:/out" pauk:latest sh -c $LinuxFinalizeClean
    if ($LASTEXITCODE -ne 0) { throw "Failed to finalize offline bundle inside container" }

    $SizeMb = [math]::Round(((Get-Item $ArchivePath).Length / 1MB), 1)
    Write-Host ""
    Write-Host "==================================================================" -ForegroundColor Green
    Write-Host " Offline bundle ready: $ArchivePath ($SizeMb MB)" -ForegroundColor Green
    Write-Host " Copy $ArchiveName to the Linux server and run:" -ForegroundColor Green
    Write-Host "   tar -xf $ArchiveName ; cd pauk-bundle ; sudo bash install.sh" -ForegroundColor Yellow
    Write-Host "==================================================================" -ForegroundColor Green
}

switch ($Mode.ToLower()) {
    "full"     { Build-PaukBundle -IncludeRobot $true  -PkgPrefix "pauk-full" }
    "pauk"     { Build-PaukBundle -IncludeRobot $true  -PkgPrefix "pauk-full" }
    "app"      { Build-PaukBundle -IncludeRobot $false -PkgPrefix "pauk-app"  }
    "pauk-app" { Build-PaukBundle -IncludeRobot $false -PkgPrefix "pauk-app"  }
    default {
        Write-Host "Usage: .\make_pauk_bundle.cmd [full|app] [output_dir]" -ForegroundColor Yellow
        exit 1
    }
}
