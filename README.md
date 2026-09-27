# Doblaje local de YouTube al español argentino

Extensión de Chrome y servicio local para traducir y doblar videos grabados de YouTube. Usa Whisper para transcribir cuando no hay subtítulos en inglés, Opus-MT en CPU para traducir y Qwen3-TTS en la GPU para generar voz. El audio y el texto se procesan localmente; YouTube solo entrega el contenido original.

## Estado real

La extensión y el servicio están implementados. El doblaje usa como referencia la voz original de cada frase del video. Si cambia el hablante entre frases, cambia también la referencia de voz. Ver [estado de implementación](reports/IMPLEMENTATION_STATUS.md) para resultados y límites.

## Instalación en esta computadora

Abrí PowerShell en esta carpeta y ejecutá:

```powershell
.\scripts\setup.ps1
.\scripts\download-models.ps1
.\scripts\start.ps1
```

Los modelos, voces y cachés se guardan en F: dentro del proyecto. `start.ps1` debe seguir abierto mientras usás la extensión. En Chrome, abrí `chrome://extensions`, activá «Modo de desarrollador», elegí «Cargar descomprimida» y seleccioná la carpeta `extension/dist`.

Al abrir las opciones de la extensión, ingresá el código de seis dígitos impreso por `start.ps1` o guardado en `data/pairing.json`. **No hace falta importar una voz:** el servicio toma muestras temporales del audio original del video y las borra al terminar la sesión. La voz opcional que se puede guardar en Opciones sirve de respaldo si no hay una primera muestra original utilizable.

Abrí un video grabado en YouTube y pulsá «Doblar este video». La extensión empieza con una reserva objetivo de 10 segundos de audio y la adapta al ritmo de generación: entre 8 y 30 segundos a velocidad normal. Después de un corte aumenta la reserva para evitar pausas repetidas. Un indicador animado muestra el progreso real, la etapa de preparación y una espera aproximada cuando hay suficientes mediciones. Los segundos de audio preparado no son segundos de espera. El deslizador del popup regula el volumen del doblaje. Para detener el servicio, pulsá Ctrl+C en la consola o ejecutá `scripts/stop.ps1` en otra consola.

## Uso y diagnóstico

`scripts/doctor.ps1` informa si faltan modelos, GPU, FFmpeg o la extensión compilada. `scripts/benchmark.ps1` usa la voz opcional `data/voices/default.wav` para una prueba aislada; deja `reports/benchmark.json` y `reports/benchmark-voice.wav`.

Cuando hay subtítulos originales, el servicio usa sus tiempos y alinea con palabras reconocidas los primeros 12 segundos de la sesión. Al adelantar reutiliza los metadatos y el audio ya obtenido, y empieza con los tiempos de los subtítulos para evitar repetir la alineación. Si no hay subtítulos, extrae ventanas de audio y las transcribe localmente. Directos, listas privadas y videos que exigen sesión de YouTube quedan fuera de esta versión.

Los subtítulos automáticos de YouTube suelen repetir parte de la línea anterior mientras van apareciendo palabras nuevas. El servicio quita ese solapamiento antes de traducir, conservando solo las palabras nuevas de cada actualización.

La sincronización es **por frase**: el inicio sigue las palabras originales y la voz generada se acelera solo lo necesario, hasta 1,5×, para intentar llegar al comienzo previsto de la frase siguiente. Si todavía necesita tiempo, el video espera brevemente a que termine; no corta la frase a la mitad. Las palabras dentro de cada frase pueden tener otro ritmo porque la traducción no dura exactamente lo mismo que el original.

La adaptación de voz también es **por frase**. Si dos personas hablan dentro de la misma frase agrupada o simultáneamente, la muestra puede contener ambas voces y el resultado puede ser inestable. La música, el ruido y las frases muy cortas también reducen la fidelidad. Todavía no hay separación de fuentes ni identificación persistente de hablantes.

Si una frase no tiene una muestra suficiente, se reutiliza la última referencia válida para continuar. Si ocurre al comienzo, se usa la voz opcional local cuando está instalada. Esa frase puede sonar como el hablante anterior. Las muestras suaves se nivelan con ganancia limitada; el audio generado también recibe nivelado y bordes suaves para reducir saltos de volumen y clics. Se conservan hasta 32 MiB de voz generada durante la sesión para reutilizar frases al volver atrás o cambiar la velocidad; esta caché se libera al detener el doblaje.

Si la extensión informa `SOURCE_UNAVAILABLE`, probá un video público distinto: este modo necesita acceso al audio original. Si informa `GPU_OOM` o se queda preparando, revisá memoria libre con `nvidia-smi` y cerrá otras aplicaciones de GPU. El archivo `data/asr-worker.log` contiene errores del proceso de transcripción.

No se utiliza ninguna API de inferencia externa. Las conexiones de red durante el uso son para YouTube y sus medios; la extensión habla con el servicio exclusivamente en `127.0.0.1`.

## Desarrollo

```powershell
$env:PYTHONPATH = (Join-Path (Get-Location) 'backend')
.\.venv\Scripts\python.exe -m pytest -q backend\tests
Push-Location extension
npm run typecheck
npm run build
npm run test:e2e
Pop-Location
```

El código está en `backend/doblaje` y `extension/src`. Los contratos de eventos y la arquitectura prevista se explican en [el plan](PLAN_IMPLEMENTACION.md). La primera versión está pensada para una sesión activa por vez.
