"""Isolate CTranslate2 CUDA DLLs from PyTorch CUDA DLLs on Windows."""
from __future__ import annotations

import json
import sys

from .config import settings


def main() -> None:
    from faster_whisper import WhisperModel
    sys.stdout.reconfigure(encoding="utf-8")
    model = None
    for line in sys.stdin.buffer:
        try:
            request = json.loads(line)
            if model is None:
                model = WhisperModel(str(settings.models / "faster-whisper-large-v3-turbo"),
                                     device="cuda", compute_type="int8_float16")
            want_words = bool(request.get("words"))
            segments, info = model.transcribe(request["path"], beam_size=3, vad_filter=True,
                                           word_timestamps=want_words,
                                           condition_on_previous_text=False)
            if info.language != "en":
                raise ValueError(f"Idioma original no compatible en esta versión: {info.language}")
            start = int(request["start_ms"])
            materialized = list(segments)
            output = [[start + round(s.start * 1000), start + round(s.end * 1000), s.text.strip()]
                      for s in materialized if s.text.strip()]
            response = {"segments": output}
            if want_words:
                response["words"] = [
                    [start + round(word.start * 1000), start + round(word.end * 1000), word.word.strip()]
                    for segment in materialized for word in (segment.words or [])
                    if word.start is not None and word.end is not None and word.word.strip()
                ]
        except Exception as exc:
            response = {"error": str(exc)}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
