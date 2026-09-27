# Estado de implementación — 26 de septiembre de 2026

## Actualización de fluidez y espera — 27 de septiembre de 2026

- La espera inicial deja de exigir siempre 25 segundos de reserva: parte de 10 segundos y se adapta según la entrega de audio. A velocidad normal, un ritmo rápido permite 8 segundos; uno lento pide 24, con un máximo de 30. Cada agotamiento aumenta la reserva para reducir pausas repetidas. Esto no equivale a garantizar una cantidad fija de segundos de espera.
- El reproductor muestra etapa, actividad animada, audio preparado y tiempo aproximado calculado a partir de entregas reales. No muestra una estimación antes de medir ni mantiene una cuenta ficticia si pasan más de 15 segundos sin progreso. Respeta movimiento reducido.
- La preparación usa dos tareas continuas con entrega ordenada, en lugar de esperar que termine cada pareja para comenzar la siguiente. La primera ventana sin subtítulos baja de 30 a 12 segundos. La sesión conserva hasta 32 MiB de voz natural reutilizable, y vuelve a ajustar la duración al cambiar velocidad.
- El audio se confirma como preparado después de descargarlo y decodificarlo. Las descargas fallidas se reintentan; si se agotan los intentos se restaura el audio original y se muestra un error. Las variaciones pequeñas del reloj dejan de reiniciar palabras en curso.
- La sesión que estaba abierta había terminado con `La frase original no contiene una muestra de voz utilizable`. Ahora las frases cortas o silenciosas reutilizan la última referencia válida; al comienzo pueden usar la voz local opcional. Esto puede reducir la semejanza con el hablante en esa frase. Se nivelan las referencias suaves y el audio generado con ganancia limitada y bordes suaves.
- Se corrigió la inicialización del documento de audio al recuperar sesiones y se retienen eventos que llegan durante el inicio o un cambio de generación.

Validación: 29 pruebas del backend correctas; TypeScript y compilación correctos; pruebas de buffer adaptable, popup/opciones, navegación, subtítulos/progreso en escritorio y 430 px, pausa/reanudación, recuperación de sesión, frase larga, reintento de descarga y variación del reloj correctas. La prueba real de YouTube `jNQXAC9IVRw` pasó con audio en reproducción, volumen 65 %, restauración del original y error de sincronización de −5 ms en el instante medido. Capturas en `subtitles-desktop.png`, `subtitles-narrow.png` y `youtube-e2e.png`.

El servicio local se reinició con esta versión y `extension/dist` quedó compilada. Las pestañas existentes requieren recargar la extensión y YouTube. No se validó una reproducción continua de 20–30 minutos ni una evaluación humana de naturalidad; el nivelado no demuestra por sí solo una mejora de acento o prosodia.

La extensión MV3, el servicio local y los modelos están instalados en esta computadora. El flujo real probado es: video público de YouTube → subtítulos originales o audio extraído → traducción local → síntesis local → WAV reproducido por el documento offscreen de Chromium. El video se silencia mientras el doblaje está activo y recupera su volumen al detenerlo.

## Evidencia ejecutada

| Prueba | Resultado |
| --- | --- |
| Backend, 11 pruebas | 11 correctas |
| TypeScript y build de la extensión | Correctos |
| Popup y opciones en Chromium | Correctos |
| Video real `jNQXAC9IVRw` en Chromium | Subtítulo traducido visible; volumen original 0 y `muted=true`; documento de audio en estado `running` con un clip reproduciéndose; volumen del doblaje regulado a 65 %; volumen original restaurado al detener |
| API con subtítulos | Primer WAV autenticado generado y descargado |
| API forzando transcripción del audio | Primer WAV entregado en 12,77 s; 24 kHz; voz de 3,36 s |
| Instalación de modelos | Descarga verificada con revisiones y SHA-256 en `models/manifest.lock.json` |
| Diagnóstico del equipo | RTX 3080 Ti de 12 GiB, CUDA disponible, FFmpeg y todos los archivos esenciales presentes |

El benchmark independiente, incluyendo cargas frías, tomó 2,34 s para resolver y leer una ventana, 10,70 s para ASR, 5,07 s para iniciar traducción y 3,83 s para sintetizar una frase de 3,36 s. El factor de tiempo real de esa primera síntesis fue 1,14; por sí solo no demuestra rendimiento sostenido. La ruta con subtítulos evita ASR. Los datos íntegros están en `reports/benchmark.json`, `reports/api-smoke.json` y `reports/api-smoke-audio.json`.

## Límites actuales

- Solo se traduce inglés a español. El voseo y léxico rioplatense dependen del texto fuente y del modelo; la voz candidata local necesita una evaluación humana del acento y naturalidad. Se puede reemplazar en Opciones con un WAV propio y su transcripción exacta.
- La prueba automatizada usó Chromium con una instalación temporal de la extensión. Aún no se hizo una escucha manual en Chrome estable ni una sesión continua de 20–30 minutos. Por eso la fluidez de una sesión larga y la calidad perceptual de la voz siguen sin validar.
- El inicio lleva varios segundos, especialmente cuando falta una pista de subtítulos ingleses. El video espera un buffer inicial y puede hacer pausas adicionales si el procesamiento no mantiene el ritmo. Los directos y videos que requieren autenticación quedan fuera del alcance actual.
- El audio original se silencia entero durante el doblaje; música y efectos también se silencian. No hay separación de voces ni mezcla de música.
- La API descarga el medio original desde YouTube; ninguna inferencia se envía a una API remota. Los modelos se descargan durante la instalación.

El objetivo de «tiempo real» está cumplido para el inicio y la reproducción fragmentada del video corto probado, pero **no está validado para videos largos sin interrupciones**. No se debe interpretar este resultado como latencia cero ni como aprobación del acento argentino.

## Actualización de sincronización — 26 de septiembre de 2026

Los subtítulos se alinean con marcas de palabras obtenidas del audio original en la primera ventana de 30 segundos. Si la coincidencia es débil o no se puede leer el audio, se conservan las marcas del subtítulo. Se recorta el silencio exterior que agrega la síntesis y el documento de audio corrige su reloj con la posición actual del reproductor. La voz se acelera hasta 1,5× para intentar terminar antes de la frase siguiente; si aun así sobra audio, el video espera a que termine.

En `jNQXAC9IVRw`, el subtítulo indicaba 1,200 s para la primera frase, mientras el reconocimiento de palabras la ubicó cerca de 0,96 s; la frase siguiente quedó cerca de 4,76 s. La prueba completa en Chromium pasó dos veces con 6 ms de diferencia entre el reloj del WAV y el del video en el instante medido. También comprobó pausa/reanudación, restauración del volumen y que el video no se congele al final del primer subtítulo cuando queda silencio antes de la frase siguiente. La API entregó el primer segmento con subtítulos en 18,15 s en una pasada fría; el costo adicional proviene principalmente de la alineación ASR. Las 14 pruebas del backend pasaron.

Esto verifica alineación del **inicio de cada frase** en el video corto de prueba. No demuestra sincronización de cada palabra o fonema dentro de la traducción ni estabilidad durante un video largo.

## Recuperación del audio

Al recuperar una sesión activa, el reproductor de audio vuelve a recibir su generación correcta. La prueba aislada de Chromium comprobó esa restauración. El video espera cinco segundos de voz preparada al inicio y vuelve a esperar cuatro segundos de reserva si se agota el buffer; no se puede saltar la espera inicial pulsando Play. Las frases largas se aceleran hasta 1,5× y, si aún sobran, terminan durante una pausa breve del video. La prueba aislada comprobó la espera, la reanudación y la pausa manual.

En videos con subtítulos, la alineación con el audio original se intenta solo para la primera ventana y su lectura tiene un límite de ocho segundos. Si falla o tarda demasiado, el servicio sigue con los tiempos de los subtítulos en vez de bloquear la generación durante 90 segundos por ventana. El servicio también evita sintetizar frases cuyo momento ya pasó. Pasaron 16 pruebas del backend y los chequeos de tipos y build de la extensión.

## Corrección de subtítulos automáticos repetidos

El video `Y_VOqVLVgMo` entregaba subtítulos progresivos con frases completas solapadas en ventanas consecutivas. Antes de traducir, el parser ahora calcula el solapamiento entre el final de la ventana anterior y el inicio de la siguiente, y conserva solo el texto nuevo. La primera frase pasó de contener tres veces «that halflife 2 is a game that's held up» a contenerla una sola vez. Se verificó con los subtítulos reales del video y una prueba de regresión; las 17 pruebas del backend pasaron.

## Frases completas

El reproductor ya no corta el WAV al alcanzar el límite temporal de la frase. El backend ajusta su velocidad hasta 1,5× cuando hace falta; el video solo espera el tiempo adicional que todavía necesite la voz. Al terminar el WAV, se reanuda el video. Si nunca llega el aviso de fin, se descarta ese clip tras un plazo calculado y no vuelve a pausarse por él. La prueba de navegador aislada pasó tres veces seguidas cubriendo fin normal, pausa manual durante la espera y recuperación sin aviso; las 18 pruebas del backend pasaron.
