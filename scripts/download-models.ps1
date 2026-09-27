$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$env:HF_HOME = Join-Path $taskRoot 'models\.hf-cache'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Primero ejecutá scripts/setup.ps1' }
& $taskPython (Join-Path $PSScriptRoot 'download_models.py')
if ($LASTEXITCODE -ne 0) { throw "Descarga fallida: código $LASTEXITCODE" }
