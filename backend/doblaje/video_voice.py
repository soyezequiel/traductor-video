from __future__ import annotations

import io
import logging
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from .config import settings
from .source import VideoSource, read_audio_window
from .types import SourceSegment


log = logging.getLogger(__name__)


class VoiceSampleUnavailable(RuntimeError):
    pass


class VideoVoice:
    """Extract a fresh speaker reference from the source interval of each phrase."""

    def __init__(self, source: VideoSource) -> None:
        self.source = source
        settings.audio_dir.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="video-voice-", dir=settings.audio_dir)
        self.window_start_ms = -1
        self.window_audio: np.ndarray | None = None
        self.window_rate = 16_000
        self.references: list[Path] = []
        self.last_usable: Path | None = None

    def close(self) -> None:
        self.directory.cleanup()

    def ingest(self, wav: bytes, start_ms: int) -> None:
        audio, rate = sf.read(io.BytesIO(wav), dtype="float32")
        if audio.ndim == 2:
            audio = audio.mean(axis=1)
        self.window_start_ms = start_ms
        self.window_audio = audio
        self.window_rate = rate

    def reference_for(self, item: SourceSegment) -> Path:
        if not self.source.audio_url:
            raise RuntimeError("No se puede leer la voz original de este video")
        # Reuse the ASR/alignment window when it contains enough of this phrase.
        # A phrase crossing a window edge must not be cloned from a tiny tail.
        if not self._contains(item):
            start = item.start_ms
            duration = min(12_000, max(1_000, (self.source.duration_ms or start + 12_000) - start))
            self.ingest(read_audio_window(self.source, start, duration, 4), start)
        assert self.window_audio is not None
        begin = max(0, round((item.start_ms - self.window_start_ms) * self.window_rate / 1000))
        end = min(len(self.window_audio), round((item.end_ms - self.window_start_ms) * self.window_rate / 1000))
        # Stay within this phrase: padding across its boundary can mix speakers.
        sample = self.window_audio[begin:min(end, begin + 8 * self.window_rate)]
        rms = float(np.sqrt(np.mean(sample**2))) if len(sample) else 0
        if len(sample) < self.window_rate // 2 or rms < 0.003:
            if self.last_usable:
                log.info("Reutilizando referencia de voz para la frase en %s ms", item.start_ms)
                return self.last_usable
            raise VoiceSampleUnavailable("La frase original no contiene una muestra de voz utilizable")
        # Keep quiet speakers useful without clipping or amplifying them without bound.
        peak = float(np.max(np.abs(sample)))
        sample = sample * min(4.0, max(0.5, 0.10 / rms), 0.92 / max(peak, 0.001))
        path = Path(self.directory.name) / f"speaker-{len(self.references):05d}.wav"
        sf.write(path, sample, self.window_rate, subtype="PCM_16")
        self.references.append(path)
        self.last_usable = path
        return path

    def _contains(self, item: SourceSegment) -> bool:
        required_end = min(item.end_ms, item.start_ms + 2000)
        return (self.window_audio is not None and item.start_ms >= self.window_start_ms
                and required_end <= self.window_start_ms + len(self.window_audio) * 1000 / self.window_rate)
