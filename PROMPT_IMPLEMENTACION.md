# Prompt para implementar el proyecto en una tarea completa

Copiar el texto siguiente en una nueva tarea de la IA con esta carpeta como espacio de trabajo. Adjuntar o mantener accesible `PLAN_IMPLEMENTACION.md` de esta misma carpeta.

---

Implementá de principio a fin el proyecto descrito en `PLAN_IMPLEMENTACION.md`. Leé el documento completo antes de escribir código. Quiero una extensión para Chrome que doble YouTube al español argentino usando exclusivamente inferencia local en Windows, con voz natural y procesamiento durante la reproducción. Acepto unos segundos de preparación inicial para conseguir mejor voz.

El equipo confirmado es Windows 11, RTX 3080 Ti de 12 GiB, Ryzen 7 5700X3D y 32 GiB de RAM. Trabajá en `F:\proyectos\traductor de voz video youtube`; guardá modelos y cachés grandes en F:. No prometas rendimiento sin medirlo.

Esta es una solicitud de implementación, no de otro plan. Avanzá por todas las etapas del documento como una sola tarea, iterando y corrigiendo errores hasta entregar una aplicación utilizable. No te detengas al terminar el scaffolding, una demo simulada o una sola etapa. Resolvé decisiones rutinarias con los defaults del plan y registrá cambios fundamentados. Respetá las instrucciones del repositorio y el trabajo existente.

Prioridades, en orden:

1. Flujo real completo: YouTube o fixture → entrada original → traducción local → voz local → reproducción sincronizada.
2. Voz argentina natural y traducción fiel.
3. Fluidez sostenida dentro de 12 GiB de VRAM.
4. Instalación y recuperación simples en Windows.

Implementá TypeScript/Manifest V3 y backend Python con modelos en procesos separados. Seguí las elecciones de modelos del plan, verificando las APIs y versiones reales antes de depender de ellas. Compará el TTS Qwen 0.6B y 1.7B en este equipo y seleccioná el mejor perfil que sostenga el pipeline completo. No descargues todas las alternativas sin necesidad ni introduzcas APIs de nube como fallback.

Usá voz fija y calidad de inglés a español argentino como defaults. Permití importar una referencia argentina con transcripción y reutilizar su condicionamiento. Si no hay una referencia disponible, completá la aplicación y sus pruebas con una voz candidata claramente identificada; entregá muestras y dejá pendiente únicamente la aprobación perceptual del acento. No inventes que una voz fue escuchada y aprobada.

Implementá acceso anticipado a subtítulos originales y audio para videos grabados. No dependas de capturar solamente lo que está sonando: eso no permite doblaje sincronizado sin retrasar también la imagen. Los directos y la clonación automática por hablante quedan fuera de V1, como indica el plan.

Mantené el reloj del video como autoridad, generation por sesión para invalidar trabajo antiguo, colas limitadas, caché con cuota y audio original restaurable. Pausar para esperar cómputo y ajustar una frase demasiado larga son casos diferentes; implementalos correctamente. Probá anuncios, cambios de video, seek, pausa, pérdida del servicio y pestaña oculta.

El servicio debe ser accesible solo en loopback, con autenticación local y validación de origin. No expongas tokens al contexto de YouTube ni uses un WebSocket suponiendo que el navegador permite headers arbitrarios. No ejecutes comandos construidos con URLs del usuario. No alteres el perfil personal del navegador para automatizar pruebas.

Podés crear/editar archivos, instalar dependencias aisladas y descargar los modelos públicos necesarios para esta implementación, usando fuentes oficiales o artefactos verificados. No modifiques drivers, políticas globales ni configuración del sistema sin necesidad; no publiques la extensión ni envíes información a terceros. Si una acción requiere interacción real del usuario, prepará todo lo independiente primero y explicá el bloqueo concreto.

Ejecutá las pruebas relevantes y benchmarks reales. Diferenciá datos medidos de objetivos, mocks de inferencia y bloqueos externos de bugs. Si una prueba no es posible, documentá por qué y completá todo el trabajo que no dependa de ella. Si no se logra tiempo real o no funciona una ruta de YouTube, dejalo visible en la aplicación y en el informe; no ocultes el incumplimiento.

Entregá como mínimo:

- Código completo y configuración con dependencias fijadas.
- `extension/dist` lista para cargar como extensión descomprimida.
- Scripts PowerShell de instalación, inicio, parada, diagnóstico y benchmark.
- Manifiesto de modelos con revisiones, tamaños, hashes y licencias reales.
- Pruebas automatizadas y evidencia de un flujo con inferencia real.
- Muestras WAV de la voz y traducción, con sus parámetros.
- README e instrucciones en español para instalar y usar.
- `reports/IMPLEMENTATION_STATUS.md` con requisitos cumplidos, pendientes, métricas y limitaciones.

El cierre debe indicar cómo arrancarlo, dónde cargar la extensión, qué se verificó realmente y qué falta. No confundas «código generado» con «aplicación validada».

---

Este prompt inicia la implementación futura. La tarea que produjo este archivo solo realizó planificación e inspección de hardware; no instaló dependencias ni ejecutó modelos.
