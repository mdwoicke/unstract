#Requires -Version 5.1
<#
.SYNOPSIS
    Unstract All-In-One Startup Script
.DESCRIPTION
    Detects machine IP, patches source files, starts Docker services, applies container
    code fixes (CORS + vision preprocessing), starts the test UI Node server, and
    verifies the LM Studio vision model context window.
#>

Set-StrictMode -Off
$ErrorActionPreference = "Continue"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────
function Write-Step([string]$msg) {
    Write-Host "`n[STEP] $msg" -ForegroundColor Cyan
}

function Write-OK([string]$msg) {
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
    Write-Host "  [WARN] $msg" -ForegroundColor Yellow
}

function Write-Fail([string]$msg) {
    Write-Host "  [FAIL] $msg" -ForegroundColor Red
}

function Wait-ForCondition {
    param(
        [scriptblock]$Condition,
        [string]$Label,
        [int]$IntervalSec = 10,
        [int]$TimeoutSec  = 120
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { Write-OK "$Label is ready"; return $true }
        Write-Host "    ... waiting for $Label" -ForegroundColor DarkGray
        Start-Sleep -Seconds $IntervalSec
    }
    Write-Fail "$Label did not become ready within ${TimeoutSec}s"
    return $false
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Detect Current Machine IP
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Detecting machine IP address"

$LOCAL_IP = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.IPAddress -notmatch '^(127\.|172\.|169\.)' -and
        $_.PrefixOrigin -eq 'Dhcp'
    } |
    Select-Object -First 1).IPAddress

if (-not $LOCAL_IP) {
    # Fallback: try Manual origin, still skip loopback/Docker bridge
    $LOCAL_IP = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object {
            $_.IPAddress -notmatch '^(127\.|172\.|169\.)' -and
            $_.PrefixOrigin -eq 'Manual'
        } |
        Select-Object -First 1).IPAddress
}

if (-not $LOCAL_IP) {
    Write-Fail "Could not detect a suitable IP address. Aborting."
    exit 1
}

Write-OK "Detected IP: $LOCAL_IP"

$UNSTRACT_ROOT  = "D:\Applications\unstract"
$DOCKER_DIR     = "$UNSTRACT_ROOT\docker"
$INDEX_HTML     = "$DOCKER_DIR\test-ui\index.html"
$SERVER_JS      = "$DOCKER_DIR\test-ui\server.js"
$DEV_PY         = "$UNSTRACT_ROOT\backend\backend\settings\dev.py"
$PROMPT_SRC     = "$UNSTRACT_ROOT\prompt-service\src\unstract\prompt_service"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Patch IP into Source Files (idempotent)
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Patching IP into source files"

# -- index.html: replace any 192.168.x.x:8000 in the apiUrl input value
$html = Get-Content $INDEX_HTML -Raw
$htmlNew = $html -replace '(value="http://)192\.168\.\d+\.\d+(:\d+/)', "`${1}${LOCAL_IP}`${2}"
if ($htmlNew -ne $html) {
    Set-Content $INDEX_HTML $htmlNew -NoNewline
    Write-OK "index.html patched with $LOCAL_IP"
} else {
    Write-OK "index.html already has correct IP"
}

# -- server.js: replace the console.log IP
$js = Get-Content $SERVER_JS -Raw
$jsNew = $js -replace 'http://192\.168\.\d+\.\d+:\$\{PORT\}/', "http://${LOCAL_IP}:`${PORT}/"
if ($jsNew -ne $js) {
    Set-Content $SERVER_JS $jsNew -NoNewline
    Write-OK "server.js patched with $LOCAL_IP"
} else {
    Write-OK "server.js already has correct IP"
}

# -- dev.py: replace ALL 192.168.x.x occurrences in CORS list with $LOCAL_IP
$py = Get-Content $DEV_PY -Raw
$pyNew = $py -replace '192\.168\.\d+\.\d+', $LOCAL_IP

# Ensure http://$LOCAL_IP:8000 is present (it may not exist if the file had none)
if ($pyNew -notmatch [regex]::Escape("http://${LOCAL_IP}:8000")) {
    $pyNew = $pyNew -replace '(# Other allowed origins if needed)', `
        "`"http://${LOCAL_IP}:8000`",`n    `${1}"
}
if ($pyNew -ne $py) {
    Set-Content $DEV_PY $pyNew -NoNewline
    Write-OK "dev.py CORS patched with $LOCAL_IP"
} else {
    Write-OK "dev.py already has correct IP"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Ensure Docker Desktop is running
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Checking Docker Desktop"

$dockerOk = ($null -eq (docker info 2>&1 | Select-String -Pattern 'error' -CaseSensitive:$false))
if (-not $dockerOk) {
    Write-Host "  Docker not running — starting Docker Desktop..." -ForegroundColor Yellow
    $dockerExe = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerExe) {
        Start-Process $dockerExe
    } else {
        Write-Fail "Docker Desktop not found at $dockerExe"
        exit 1
    }
    $ready = Wait-ForCondition `
        -Condition { ($null -eq (docker info 2>&1 | Select-String -Pattern 'error' -CaseSensitive:$false)) } `
        -Label "Docker Desktop" `
        -IntervalSec 5 `
        -TimeoutSec 120
    if (-not $ready) { exit 1 }
} else {
    Write-OK "Docker Desktop is already running"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — Free Port 5555
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Freeing port 5555"

$conns = Get-NetTCPConnection -LocalPort 5555 -ErrorAction SilentlyContinue
if ($conns) {
    foreach ($conn in $conns) {
        try {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            Write-OK "Killed PID $($conn.OwningProcess) on port 5555"
        } catch { }
    }
    Start-Sleep -Seconds 1
} else {
    Write-OK "Port 5555 is free"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — Start Core Docker Containers
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Starting Docker Compose services"

Push-Location $DOCKER_DIR
docker compose up -d
Pop-Location

Write-Host "  Waiting for infrastructure services to be healthy..." -ForegroundColor DarkGray

# DB
Wait-ForCondition `
    -Condition { (docker exec unstract-db pg_isready -U unstract_dev 2>&1) -match 'accepting connections' } `
    -Label "unstract-db" | Out-Null

# Redis
Wait-ForCondition `
    -Condition { (docker exec unstract-redis redis-cli ping 2>&1) -eq 'PONG' } `
    -Label "unstract-redis" | Out-Null

# RabbitMQ
Wait-ForCondition `
    -Condition { (docker exec unstract-rabbitmq rabbitmq-diagnostics ping 2>&1) -match 'Ping' } `
    -Label "unstract-rabbitmq" | Out-Null

# Backend
Wait-ForCondition `
    -Condition {
        try { (Invoke-WebRequest -Uri "http://localhost:8000/api/v1/health/" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch { $false }
    } `
    -Label "unstract-backend" `
    -TimeoutSec 180 | Out-Null

# Prompt service
Wait-ForCondition `
    -Condition {
        try {
            (docker exec unstract-prompt-service curl -s -o /dev/null -w "%{http_code}" http://localhost:3003/health 2>&1) -eq '200'
        } catch { $false }
    } `
    -Label "unstract-prompt-service" | Out-Null

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 — Repair Tool Registry Adapter Cache
# ─────────────────────────────────────────────────────────────────────────────
# The prompt_studio_registry.tool_metadata column is a static serialized
# snapshot written at export time.  It does NOT auto-update when you change
# profiles in Prompt Studio.  If you ever swap/delete an LLM adapter the
# cached UUID becomes stale and every run fails with "Adapter not found".
# This step repairs the cache idempotently on every startup.
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Repairing tool registry adapter cache"

# -- Helper: run a SQL query and return the trimmed first result
function Invoke-Psql([string]$sql) {
    (docker exec unstract-db psql -U unstract_dev -d unstract_db -t -A -c $sql 2>&1).Trim()
}

# Tool → Canonical LLM adapter name mapping
# Add more rows here if you create additional exported tools in future.
$toolAdapterMap = @{
    "MBN" = "Qwen-3L"
}

$registryFixed  = 0
$registryErrors = 0

foreach ($toolName in $toolAdapterMap.Keys) {
    $adapterName = $toolAdapterMap[$toolName]

    # Resolve adapter UUID by name (safe even if UUID changes)
    $correctUuid = Invoke-Psql `
        "SELECT id FROM unstract.adapter_instance WHERE adapter_name = '$adapterName' AND adapter_type = 'LLM' LIMIT 1;"

    if ($correctUuid -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        Write-Warn "Adapter '$adapterName' not found in DB — cannot repair '$toolName' cache."
        $registryErrors++
        continue
    }

    # Get current LLM UUID baked into tool_metadata
    $cachedUuid = Invoke-Psql `
        "SELECT tool_metadata->'tool_settings'->>'llm' FROM unstract.prompt_studio_registry WHERE name = '$toolName';"

    if (-not $cachedUuid) {
        Write-Warn "Tool '$toolName' not found in prompt_studio_registry. Skipping."
        $registryErrors++
        continue
    }

    if ($cachedUuid -ne $correctUuid) {
        # Replace ALL occurrences of the stale UUID with the correct one
        # (covers tool_settings.llm, tool_settings.challenge_llm, and each output's llm)
        Invoke-Psql @"
UPDATE unstract.prompt_studio_registry
SET tool_metadata = to_jsonb(replace(tool_metadata::text, '$cachedUuid', '$correctUuid')::jsonb)
WHERE name = '$toolName';
"@ | Out-Null
        Write-Warn "  [$toolName] tool_metadata was stale ('$($cachedUuid.Substring(0,8))...') — fixed to $adapterName"
        $registryFixed++
    } else {
        Write-OK "  [$toolName] tool_metadata cache is correct ($adapterName)"
    }

    # Keep profile_manager in sync as a belt-and-suspenders check
    Invoke-Psql @"
UPDATE unstract.profile_manager
SET llm_id = '$correctUuid'
WHERE profile_name = '$toolName' AND llm_id::text != '$correctUuid';
"@ | Out-Null
}

if ($registryErrors -eq 0) {
    Write-OK "Tool registry cache check complete ($registryFixed repaired)"
} else {
    Write-Warn "Tool registry check finished with $registryErrors warning(s) — review above"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 7 — Apply Code Fixes to Containers (CORS + Vision)
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Applying code fixes to containers"

# Backend: copy patched dev.py and restart
Write-Host "  Copying dev.py into unstract-backend..." -ForegroundColor DarkGray
docker cp "$DEV_PY" "unstract-backend:/app/backend/settings/dev.py"
docker restart unstract-backend

Write-Host "  Waiting for backend to recover after restart..." -ForegroundColor DarkGray
Wait-ForCondition `
    -Condition {
        try { (Invoke-WebRequest -Uri "http://localhost:8000/api/v1/health/" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch { $false }
    } `
    -Label "unstract-backend (post-restart)" `
    -TimeoutSec 120 | Out-Null

# Prompt-service: copy 4 vision/retrieval files and restart
Write-Host "  Copying vision fix files into unstract-prompt-service..." -ForegroundColor DarkGray
$psContainer = "unstract-prompt-service"
$psContainerBase = "/app/src/unstract/prompt_service"

docker cp "$PROMPT_SRC\services\retrieval.py"         "${psContainer}:${psContainerBase}/services/retrieval.py"
docker cp "$PROMPT_SRC\services\answer_prompt.py"     "${psContainer}:${psContainerBase}/services/answer_prompt.py"
docker cp "$PROMPT_SRC\utils\claude_preprocessor.py"  "${psContainer}:${psContainerBase}/utils/claude_preprocessor.py"
docker cp "$PROMPT_SRC\utils\pdf_vision.py"           "${psContainer}:${psContainerBase}/utils/pdf_vision.py"
docker cp "$PROMPT_SRC\utils\pdf_form_fields.py"      "${psContainer}:${psContainerBase}/utils/pdf_form_fields.py"

docker restart $psContainer

Write-Host "  Waiting for prompt-service to recover after restart..." -ForegroundColor DarkGray
Wait-ForCondition `
    -Condition {
        try {
            (docker exec unstract-prompt-service curl -s -o /dev/null -w "%{http_code}" http://localhost:3003/health 2>&1) -eq '200'
        } catch { $false }
    } `
    -Label "unstract-prompt-service (post-restart)" | Out-Null

Write-OK "All container code fixes applied"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 8 — Verify CORS Headers
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Verifying CORS headers"

$corsStatus = "UNKNOWN"
try {
    $corsResponse = Invoke-WebRequest `
        -Method Options `
        -Uri "http://${LOCAL_IP}:8000/deployment/api/mock_org/mbn_api/" `
        -Headers @{
            "Origin"                         = "http://${LOCAL_IP}:5555"
            "Access-Control-Request-Method"  = "POST"
        } `
        -UseBasicParsing `
        -TimeoutSec 10 `
        -ErrorAction SilentlyContinue

    $allowedOrigin = $corsResponse.Headers["Access-Control-Allow-Origin"]
    if ($allowedOrigin -eq "http://${LOCAL_IP}:5555") {
        Write-OK "CORS OK — Access-Control-Allow-Origin: $allowedOrigin"
        $corsStatus = "OK ($LOCAL_IP`:5555 allowed)"
    } else {
        Write-Warn "CORS header mismatch. Got: '$allowedOrigin' (expected 'http://${LOCAL_IP}:5555')"
        Write-Warn "Extraction requests from the test UI may be blocked."
        $corsStatus = "MISMATCH (got: $allowedOrigin)"
    }
} catch {
    Write-Warn "Could not reach backend for CORS check: $_"
    $corsStatus = "CHECK FAILED"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 9 — Start Test UI Node Server
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Starting Test UI Node server on port 5555"

# Kill anything still on 5555 (belt-and-suspenders)
$conns = Get-NetTCPConnection -LocalPort 5555 -ErrorAction SilentlyContinue
if ($conns) {
    foreach ($conn in $conns) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
}

$nodeProc = Start-Process "node" `
    -ArgumentList "`"$DOCKER_DIR\test-ui\server.js`"" `
    -WindowStyle Hidden `
    -PassThru

Start-Sleep -Seconds 2

$uiStatus = "UNKNOWN"
try {
    $uiCheck = Invoke-WebRequest -Uri "http://localhost:5555" -UseBasicParsing -TimeoutSec 5
    if ($uiCheck.StatusCode -eq 200) {
        Write-OK "Test UI server running on port 5555 (PID $($nodeProc.Id))"
        $uiStatus = "Running on port 5555"
    } else {
        Write-Warn "Test UI returned status $($uiCheck.StatusCode)"
        $uiStatus = "Unexpected status $($uiCheck.StatusCode)"
    }
} catch {
    Write-Warn "Test UI server did not respond on port 5555: $_"
    $uiStatus = "NOT RESPONDING"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 10 — Check LM Studio API + Vision Context Warning
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Checking LM Studio API"

$lmStatus = "NOT RUNNING"
try {
    $models = Invoke-RestMethod -Uri "http://localhost:1234/v1/models" -TimeoutSec 5
    $modelIds = $models.data.id -join ', '
    Write-OK "LM Studio API is running. Models: $modelIds"

    $contextSize = $models.data[0].context_length
    if ($null -eq $contextSize) {
        Write-Warn "Could not read context_length from model metadata."
        $lmStatus = "Running (context size unknown)"
    } elseif ($contextSize -lt 16384) {
        Write-Warn "Model context is only $contextSize tokens (need >= 16384)."
        Write-Warn "Vision extraction: all PDF images will be DROPPED -> garbled address/fee extraction."
        Write-Warn "Fix: In LM Studio, increase context window to >= 16k in model settings."
        $lmStatus = "WARNING — context only ${contextSize} tokens (need 16384+)"
    } else {
        Write-OK "Model context: $contextSize tokens (sufficient for vision extraction)"
        $lmStatus = "Running — context ${contextSize} tokens OK"
    }
} catch {
    Write-Warn "LM Studio API not running on port 1234. Vision extraction will be disabled."
    Write-Warn "Start LM Studio and load a vision model to enable PDF image-based extraction."
    $lmStatus = "NOT RUNNING"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 11 — Final Status Summary
# ─────────────────────────────────────────────────────────────────────────────

# Count running containers
$runningContainers = (docker ps --format "{{.Names}}" 2>/dev/null | Measure-Object -Line).Lines
$totalContainers   = (docker ps -a --format "{{.Names}}" 2>/dev/null | Measure-Object -Line).Lines

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " UNSTRACT STARTUP COMPLETE" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Machine IP:      $LOCAL_IP"
Write-Host " PDF Uploader UI: http://${LOCAL_IP}:5555"
Write-Host " Backend API:     http://${LOCAL_IP}:8000"
Write-Host " Frontend:        http://frontend.unstract.localhost"
Write-Host " RabbitMQ UI:     http://localhost:15672"
Write-Host " MinIO Console:   http://localhost:9001"
Write-Host " Traefik UI:      http://localhost:8080"
Write-Host "------------------------------------------------------------"
$registryStatus = if ($registryErrors -gt 0) { "WARNING ($registryErrors error(s))" } `
                  elseif ($registryFixed -gt 0)  { "Repaired ($registryFixed fixed)" } `
                  else                            { "OK (all correct)" }
Write-Host " Docker Services: $runningContainers/$totalContainers running"
Write-Host " Tool Registry:   $registryStatus"
Write-Host " CORS:            $corsStatus"
Write-Host " Vision patches:  Applied to prompt-service"
Write-Host " LM Studio:       $lmStatus"
Write-Host " Test UI Server:  $uiStatus"
Write-Host "============================================================" -ForegroundColor Cyan
