$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    py -3.12 -m venv --system-site-packages (Join-Path $taskRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el entorno Python 3.12' }
}
& $taskPython -m pip install --disable-pip-version-check -e (Join-Path $taskRoot 'backend')
if ($LASTEXITCODE -ne 0) { throw 'No se pudieron instalar dependencias Python' }
Push-Location (Join-Path $taskRoot 'extension')
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci falló' }
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript contiene errores' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo compilar la extensión' }
} finally { Pop-Location }
Write-Host 'Entorno preparado. Ahora ejecutá scripts/download-models.ps1'
