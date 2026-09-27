$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Primero ejecutá scripts/setup.ps1' }
$env:HF_HOME = Join-Path $taskRoot 'models\.hf-cache'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
& $taskPython (Join-Path $PSScriptRoot 'benchmark.py')
if ($LASTEXITCODE -ne 0) { throw "Benchmark falló: $LASTEXITCODE" }
