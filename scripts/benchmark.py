"""Measure a real local ASR -> translation -> TTS pass."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("HF_HOME", str(ROOT / "models" / ".hf-cache"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

from doblaje.models import adjust_audio, recognizer, synthesizer, translator  # noqa: E402
from doblaje.session import voice_reference  # noqa: E402
from doblaje.source import read_audio_window, resolve  # noqa: E402


def gpu_memory() -> int | None:
    try:
        value = subprocess.check_output([
            "nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            text=True, timeout=4).strip().splitlines()[0]
        return int(value)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video-id", default="jNQXAC9IVRw")
    args = parser.parse_args()
    report_dir = ROOT / "reports"
    report_dir.mkdir(exist_ok=True)
    voice_file, transcript = voice_reference("default")
    timings = {}
    start = time.perf_counter()
    video = resolve(args.video_id, want_audio=True)
    window = read_audio_window(video, 0, 15000)
    timings["source_s"] = round(time.perf_counter() - start, 3)

    start = time.perf_counter()
    segments = recognizer.transcribe(window, 0)
    timings["asr_s"] = round(time.perf_counter() - start, 3)
    if not segments:
        raise RuntimeError("ASR no reconoció voz en la prueba")
    text = segments[0][2]

    start = time.perf_counter()
    translation = translator.translate(text)
    timings["translation_s"] = round(time.perf_counter() - start, 3)

    start = time.perf_counter()
    wav, sample_rate, duration_ms = synthesizer.synthesize(translation, voice_file, transcript)
    timings["tts_s"] = round(time.perf_counter() - start, 3)
    (report_dir / "benchmark-voice.wav").write_bytes(wav)
    report = {"video_id": args.video_id, "source_text": text,
              "translation": translation, "sample_rate": sample_rate,
              "tts_duration_ms": duration_ms, "timings": timings,
              "tts_rtf": round(timings["tts_s"] / (duration_ms / 1000), 3),
              "gpu_memory_used_mib_after": gpu_memory(),
              "note": "Primera pasada, incluye carga fría; no demuestra rendimiento sostenido."}
    (report_dir / "benchmark.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    translator.stop()
    recognizer.stop()


if __name__ == "__main__":
    main()
