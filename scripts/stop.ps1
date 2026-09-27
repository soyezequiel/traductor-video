$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$taskListen = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $taskListen) { Write-Host 'El servicio ya está detenido.'; exit 0 }
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($taskListen.OwningProcess)"
$taskCommand = [string]$taskProcess.CommandLine
$taskPidFile = Join-Path $taskRoot 'data\server.pid'
$taskRecordedPid = if (Test-Path -LiteralPath $taskPidFile) { [int](Get-Content -LiteralPath $taskPidFile -Raw) } else { -1 }
if ($taskListen.OwningProcess -ne $taskRecordedPid -or -not $taskCommand.Contains('uvicorn doblaje.api:app')) {
    throw 'El puerto 8765 pertenece a otro proceso; no se detuvo.'
}
Stop-Process -Id $taskListen.OwningProcess
Write-Host 'Servicio local detenido.'
