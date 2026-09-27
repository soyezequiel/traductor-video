# Componentes de terceros

Este proyecto usa los siguientes proyectos y artefactos locales. Consultá la licencia de cada revisión antes de redistribuir binarios o pesos:

| Componente | Origen | Uso |
| --- | --- | --- |
| faster-whisper | https://github.com/SYSTRAN/faster-whisper | Transcripción |
| Whisper large-v3-turbo convertido | https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo | Pesos ASR |
| Opus-MT en CTranslate2 | https://huggingface.co/michaelfeil/ct2fast-opus-mt-en-es | Traducción inglés-español |
| CTranslate2 | https://github.com/OpenNMT/CTranslate2 | Runtime de traducción y ASR |
| llama.cpp | https://github.com/ggml-org/llama.cpp | Runtime de voz |
| Qwen3-TTS Base GGUF | https://huggingface.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF | Voz clonada |
| Qwen3-TTS VoiceDesign | https://github.com/QwenLM/Qwen3-TTS | Generación inicial de voz candidata |
| yt-dlp y yt-dlp-ejs | https://github.com/yt-dlp/yt-dlp | Entrada de video y subtítulos |
| FFmpeg | https://ffmpeg.org/ | Decodificación y ajuste de duración |
| Vite y esbuild | https://vite.dev/ y https://esbuild.github.io/ | Compilación de extensión |

`models/manifest.lock.json` contiene revisiones y SHA-256 de los archivos descargados en esta instalación. No se incluyen modelos ni archivos de YouTube en el código fuente.
