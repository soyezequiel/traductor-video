"""Compare local Qwen TTS launch settings without changing the running service."""
from __future__ import annotations

import concurrent.futures
import json
import subprocess
import tempfile
import time
from pathlib import Path

import soundfile as sf


ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "models/llama/llama-tts.exe"
MODEL = ROOT / "models/llama-tts/Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf"
PROJECTOR = ROOT / "models/llama-tts/mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf"
VOICE = ROOT / "data/voices/default.wav"
PHRASES = (
    "Bueno, ahora vamos a ver cómo funciona este juego y qué cosas podemos hacer acá.",
    "Después de algunos minutos, el personaje encuentra una puerta y comienza una aventura nueva.",
)


def run(text: str, context: int | None) -> dict:
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / "voice.wav"
        command = [str(EXE), "-m", str(MODEL), "-mm", str(PROJECTOR),
                   "-p", text, "--tts-lang", "es", "--tts-speaker-file", str(VOICE),
                   "--output", str(output), "-ngl", "99", "-n", "300"]
        if context:
            command.extend(["-c", str(context)])
        start = time.perf_counter()
        result = subprocess.run(command, capture_output=True, timeout=120,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        elapsed = time.perf_counter() - start
        if result.returncode:
            return {"context": context, "seconds": round(elapsed, 2),
                    "error": result.stderr.decode("utf-8", "replace")[-600:]}
        info = sf.info(output)
        return {"context": context, "seconds": round(elapsed, 2),
                "audio_seconds": round(info.duration, 2)}


def main() -> None:
    results = {"default": [run(phrase, None) for phrase in PHRASES],
               "ctx_4096": [run(phrase, 4096) for phrase in PHRASES]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        start = time.perf_counter()
        futures = [pool.submit(run, phrase, 4096) for phrase in PHRASES]
        phrases = [future.result() for future in futures]
        results["parallel_4096"] = {"wall_seconds": round(time.perf_counter() - start, 2),
                                      "phrases": phrases}
    print(json.dumps(results, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
