from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    root: Path = ROOT
    data: Path = Path(os.getenv("DOBLAJE_DATA", ROOT / "data"))
    models: Path = Path(os.getenv("DOBLAJE_MODELS", ROOT / "models"))
    ffmpeg: str = os.getenv("DOBLAJE_FFMPEG", "ffmpeg")
    llama_url: str = os.getenv("DOBLAJE_LLAMA_URL", "http://127.0.0.1:8766")
    asr_model: str = os.getenv("DOBLAJE_ASR_MODEL", "mobiuslabsgmbh/faster-whisper-large-v3-turbo")
    tts_model: str = os.getenv("DOBLAJE_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-Base")
    bind: str = "127.0.0.1"
    port: int = 8765

    @property
    def audio_dir(self) -> Path:
        return self.data / "audio"

    @property
    def voices_dir(self) -> Path:
        return self.data / "voices"

    @property
    def token_file(self) -> Path:
        return self.data / "pairing.json"

    def ensure_dirs(self) -> None:
        for path in (self.data, self.models, self.audio_dir, self.voices_dir):
            path.mkdir(parents=True, exist_ok=True)


settings = Settings()
