"""Download exactly the models needed for the first local profile, with hashes."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import zipfile
from pathlib import Path

import httpx
from huggingface_hub import HfApi, snapshot_download


ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"
MODELS.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("HF_HOME", str(MODELS / ".hf-cache"))


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def download_asset(url: str, path: Path) -> None:
    if path.is_file():
        return
    temporary = path.with_suffix(path.suffix + ".part")
    with httpx.stream("GET", url, follow_redirects=True, timeout=120) as response:
        response.raise_for_status()
        with temporary.open("wb") as out:
            for chunk in response.iter_bytes(chunk_size=4 * 1024 * 1024):
                out.write(chunk)
    temporary.replace(path)


def download_llama() -> dict:
    tag = "b11191"
    base = f"https://github.com/ggml-org/llama.cpp/releases/download/{tag}/"
    names = [f"llama-{tag}-bin-win-cuda-12.4-x64.zip",
             "cudart-llama-bin-win-cuda-12.4-x64.zip"]
    expected = {names[0]: "6df7f06043aecfddeac6487432db2c94b88f7974ee7952e399f26dfe189f6010",
                names[1]: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6"}
    directory = MODELS / "llama"
    directory.mkdir(exist_ok=True)
    assets = []
    for name in names:
        archive = MODELS / name
        print(f"Descargando {name}", flush=True)
        download_asset(base + name, archive)
        if sha256(archive) != expected[name]:
            raise RuntimeError(f"SHA-256 inválido para {name}; no se extrae")
        assets.append({"name": name, "url": base + name, "bytes": archive.stat().st_size,
                       "sha256": sha256(archive)})
        with zipfile.ZipFile(archive) as zipped:
            for info in zipped.infolist():
                if info.is_dir() or not info.filename.lower().endswith((".exe", ".dll")):
                    continue
                destination = directory / Path(info.filename).name
                if not destination.is_file():
                    with zipped.open(info) as src, destination.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
    if not (directory / "llama-tts.exe").is_file():
        raise RuntimeError("El archivo llama-tts.exe no apareció en la versión fijada")
    return {"release": tag, "assets": assets}


def download_hf(repo: str, destination: str, allow_patterns: list[str] | None = None) -> dict:
    api = HfApi()
    info = api.model_info(repo)
    revision = info.sha
    target = MODELS / destination
    print(f"Descargando {repo}@{revision}", flush=True)
    snapshot_download(repo_id=repo, revision=revision, local_dir=target,
                      allow_patterns=allow_patterns)
    files = [{"path": str(file.relative_to(target)).replace("\\", "/"),
              "bytes": file.stat().st_size, "sha256": sha256(file)}
             for file in sorted(target.rglob("*")) if file.is_file() and ".cache" not in file.parts]
    return {"repo": repo, "revision": revision,
            "license": (info.card_data or {}).get("license", "not_declared"), "files": files}


def main() -> None:
    manifest = {"models": {}, "runtime": {}}
    manifest["models"]["translation_primary"] = download_hf(
        "michaelfeil/ct2fast-opus-mt-en-es", "ct2-opus-mt-en-es",
        ["model.bin", "shared_vocabulary.txt", "source.spm", "target.spm", "config.json"])
    manifest["models"]["tts_native"] = download_hf(
        "ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF", "llama-tts",
        ["Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf",
         "mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf"])
    manifest["models"]["asr"] = download_hf(
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo", "faster-whisper-large-v3-turbo")
    manifest["runtime"]["llama.cpp"] = download_llama()
    (MODELS / "manifest.lock.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False),
                                                 encoding="utf-8")
    print("Modelos y runtime listos. Manifiesto: models/manifest.lock.json", flush=True)


if __name__ == "__main__":
    main()
