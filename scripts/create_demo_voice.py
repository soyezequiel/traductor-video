"""Create a local candidate voice; human listening is still needed to validate accent."""
from __future__ import annotations

import gc
import hashlib
import json
import os
from pathlib import Path

import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("HF_HOME", str(ROOT / "models" / ".hf-cache"))
MODEL_DIR = ROOT / "models" / "Qwen3-TTS-12Hz-1.7B-VoiceDesign"
VOICES = ROOT / "data" / "voices"
TEXT = ("Hola, soy una voz de prueba para el doblaje. "
        "Si tenés ganas, escuchá este ejemplo y decime si suena natural.")
INSTRUCTION = ("Una voz femenina adulta de Buenos Aires, Argentina, natural y cálida. "
               "Habla español rioplatense con acento argentino auténtico, yeísmo rehilado "
               "suave y voseo; tono conversacional, claro, sin actuación ni exageración.")


def main() -> None:
    import torch
    from huggingface_hub import HfApi, snapshot_download
    from qwen_tts import Qwen3TTSModel

    VOICES.mkdir(parents=True, exist_ok=True)
    repo = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
    revision = HfApi().model_info(repo).sha
    print(f"Descargando voz de diseño {repo}@{revision}", flush=True)
    snapshot_download(repo_id=repo, revision=revision, local_dir=MODEL_DIR)
    print("Generando la muestra local…", flush=True)
    model = Qwen3TTSModel.from_pretrained(str(MODEL_DIR), device_map="cuda:0",
                                          dtype=torch.float16, attn_implementation="sdpa")
    waveforms, sample_rate = model.generate_voice_design(text=TEXT, instruct=INSTRUCTION,
                                                          language="Spanish")
    target = VOICES / "default.wav"
    sf.write(target, waveforms[0], sample_rate, subtype="PCM_16")
    metadata = {"name": "Voz argentina candidata", "transcript": TEXT,
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "model": repo, "revision": revision,
                "accent_verified_by_human": False}
    (VOICES / "default.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False),
                                            encoding="utf-8")
    print(f"Muestra: {target}; duración: {len(waveforms[0]) / sample_rate:.1f} s", flush=True)
    del model
    gc.collect()
    torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
