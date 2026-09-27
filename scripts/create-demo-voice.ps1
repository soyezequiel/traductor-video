$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Primero ejecutá scripts/setup.ps1' }
$env:HF_HOME = Join-Path $taskRoot 'models\.hf-cache'
& $taskPython (Join-Path $PSScriptRoot 'create_demo_voice.py')
if ($LASTEXITCODE -ne 0) { throw "No se pudo crear la voz candidata: $LASTEXITCODE" }
