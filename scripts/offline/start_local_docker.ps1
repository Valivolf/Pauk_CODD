# Auto-start Docker Desktop, build/update Pauk containers from local files, and launch on http://localhost:3000
# Usage:
#   .\start_local_docker.cmd
#   .\start_local_docker.cmd full     (also builds and starts yandex-robot browser container)
#   .\start_local_docker.cmd restart  (restarts containers without full rebuild)

param(
    [Parameter(Position = 0)]
    [string]$Mode = "app",

    [switch]$NoBrowser
)

$ErrorActionPreference = "Continue"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

function Test-DockerEngine {
    cmd /c "docker info >nul 2>nul"
    return ($LASTEXITCODE -eq 0)
}

function Ensure-DockerRunning {
    if (Test-DockerEngine) {
        Write-Host "[Docker] Engine is already running." -ForegroundColor Green
        return
    }

    Write-Host "[Docker] Docker Engine is not running yet. Searching for Docker Desktop..." -ForegroundColor Yellow

    $Candidates = @(
        (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"),
        "C:\Program Files\Docker\Docker\Docker Desktop.exe",
        (Join-Path $env:LOCALAPPDATA "Docker\Docker Desktop.exe")
    )

    $DockerExe = $null
    foreach ($p in $Candidates) {
        if ($p -and (Test-Path $p)) {
            $DockerExe = $p
            break
        }
    }

    if ($DockerExe) {
        Write-Host "[Docker] Starting Docker Desktop: $DockerExe" -ForegroundColor Cyan
        Start-Process -FilePath $DockerExe
    } else {
        Write-Host "[Docker] Docker Desktop.exe not found in standard paths. Trying to start com.docker.service..." -ForegroundColor Yellow
        Start-Service -Name "com.docker.service" -ErrorAction SilentlyContinue
    }

    Write-Host "[Docker] Waiting for Docker Engine daemon to initialize (up to 120 seconds)..." -ForegroundColor Cyan
    for ($i = 1; $i -le 40; $i++) {
        Start-Sleep -Seconds 3
        if (Test-DockerEngine) {
            Write-Host ""
            Write-Host "[Docker] Docker Engine is online and ready!" -ForegroundColor Green
            return
        }
        Write-Host -NoNewline "."
    }

    Write-Host ""
    Write-Host "ERROR: Docker Engine did not start within 120 seconds." -ForegroundColor Red
    Write-Host "Please open the 'Docker Desktop' app on Windows and check if it asks to enable WSL2 / Virtualization:" -ForegroundColor Yellow
    Write-Host "  1. Open Docker Desktop from the Start Menu and accept the terms if prompted." -ForegroundColor Yellow
    Write-Host "  2. If Docker Desktop asks for WSL2, run in Administrator PowerShell:  wsl --install --no-distribution" -ForegroundColor Yellow
    exit 1
}

Ensure-DockerRunning

# Prepare local directories and .env
foreach ($dir in @("data", "data\robot", "backups", "photos")) {
    $full = Join-Path $RepoRoot $dir
    if (-not (Test-Path $full)) {
        New-Item -ItemType Directory -Path $full -Force | Out-Null
    }
}

$EnvPath = Join-Path $RepoRoot ".env"
$EnvExamplePath = Join-Path $RepoRoot ".env.example"
if (-not (Test-Path $EnvPath) -and (Test-Path $EnvExamplePath)) {
    Copy-Item $EnvExamplePath $EnvPath -Force
    Write-Host "[Config] Created .env from .env.example" -ForegroundColor Green
}

if ($Mode.ToLower() -eq "restart") {
    Write-Host "[Pauk] Restarting existing containers..." -ForegroundColor Cyan
    docker compose -f docker/docker-compose.yml -f docker/docker-compose.local.yml up -d lan-calendar codd-bot
    if ($LASTEXITCODE -ne 0) { exit 1 }
} elseif ($Mode.ToLower() -eq "full" -or $Mode.ToLower() -eq "robot") {
    Write-Host "[Pauk] Building/updating Docker images (app + bot + Chromium robot) from current files..." -ForegroundColor Cyan
    docker compose -f docker/docker-compose.yml -f docker/docker-compose.local.yml --profile robot up -d --build --remove-orphans lan-calendar codd-bot yandex-robot
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to build/start containers." -ForegroundColor Red
        exit 1
    }
    docker tag lan-calendar:latest pauk:latest 2>$null
    docker tag lan-calendar-robot:latest pauk-robot:latest 2>$null
} else {
    Write-Host "[Pauk] Building/updating Docker image from current project files and starting containers..." -ForegroundColor Cyan
    docker compose -f docker/docker-compose.yml -f docker/docker-compose.local.yml up -d --build --remove-orphans lan-calendar codd-bot
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to build/start containers." -ForegroundColor Red
        exit 1
    }
    docker tag lan-calendar:latest pauk:latest 2>$null
}

Write-Host "[Pauk] Waiting for web server on http://localhost:3000 ..." -ForegroundColor Cyan
$Ready = $false
for ($i = 1; $i -le 30; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:3000/healthz" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) {
            $Ready = $true
            break
        }
    } catch {}
    Start-Sleep -Seconds 2
}

Write-Host ""
docker ps --filter "name=lan-calendar" --filter "name=codd-bot" --filter "name=yandex-robot"

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Green
if ($Ready) {
    Write-Host " Pauk is running in Docker: http://localhost:3000" -ForegroundColor Green
    Write-Host " Default login (first run): admin / admin123" -ForegroundColor Yellow
    if (-not $NoBrowser) {
        Start-Process "http://localhost:3000"
    }
} else {
    Write-Host " Containers started, check logs if needed: docker logs --tail 50 lan-calendar" -ForegroundColor Yellow
}
Write-Host "==================================================================" -ForegroundColor Green
