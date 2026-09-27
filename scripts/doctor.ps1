$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
Write-Host 'Python 3.12:'
py -3.12 --version
Write-Host 'GPU:'
nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader
Write-Host 'FFmpeg:'
ffmpeg -version | Select-Object -First 1
Write-Host 'Archivos necesarios:'
@('extension\dist\manifest.json','models\llama\llama-tts.exe',
  'models\ct2-opus-mt-en-es\model.bin',
  'models\llama-tts\Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf',
  'models\llama-tts\mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf',
  'models\faster-whisper-large-v3-turbo') |
    ForEach-Object { [pscustomobject]@{ Archivo = $_; Existe = Test-Path -LiteralPath (Join-Path $taskRoot $_) } } |
    Format-Table -AutoSize
if (Test-Path -LiteralPath $taskPython) {
    & $taskPython -c "import torch; print('CUDA en PyTorch:', torch.cuda.is_available())"
}
