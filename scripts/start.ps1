$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Primero ejecutá scripts/setup.ps1' }
$env:HF_HOME = Join-Path $taskRoot 'models\.hf-cache'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:PYTHONPATH = Join-Path $taskRoot 'backend'
& $taskPython -m uvicorn doblaje.api:app --host 127.0.0.1 --port 8765
