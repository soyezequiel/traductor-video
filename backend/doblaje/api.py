from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import logging
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

import soundfile as sf
from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import settings
from .models import recognizer, translator
from .session import manager
from .source import parse_video_id
from .types import ControlRequest, StartRequest, VoiceImport


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger(__name__)
PAIRING_CODE: str = ""
TOKEN: str = ""
TICKETS: dict[str, float] = {}
PAIR_ATTEMPTS: dict[str, list[float]] = {}
EXTENSION_ORIGIN = re.compile(r"^chrome-extension://[a-p]{32}$")


def load_secret() -> None:
    global PAIRING_CODE, TOKEN
    settings.ensure_dirs()
    for pattern in ("*.wav", "*.media"):
        for old_audio in settings.audio_dir.glob(pattern):
            if time.time() - old_audio.stat().st_mtime > 86400:
                old_audio.unlink(missing_ok=True)
    if settings.token_file.exists():
        data = json.loads(settings.token_file.read_text(encoding="utf-8"))
        PAIRING_CODE, TOKEN = data["code"], data.get("token", "")
    else:
        PAIRING_CODE = f"{secrets.randbelow(1_000_000):06d}"
        TOKEN = ""
        save_secret()


def save_secret() -> None:
    temporary = settings.token_file.with_suffix(".tmp")
    temporary.write_text(json.dumps({"code": PAIRING_CODE, "token": TOKEN}), encoding="utf-8")
    temporary.replace(settings.token_file)


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_secret()
    pid_file = settings.data / "server.pid"
    pid_file.write_text(str(os.getpid()), encoding="ascii")
    log.info("Código de emparejamiento: %s", PAIRING_CODE)
    try:
        yield
    finally:
        if manager.active:
            await manager.control(manager.active.id, "stop")
        translator.stop()
        recognizer.stop()
        if pid_file.is_file() and pid_file.read_text(encoding="ascii") == str(os.getpid()):
            pid_file.unlink(missing_ok=True)


app = FastAPI(title="Doblaje local", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origin_regex=r"chrome-extension://[a-p]{32}",
                   allow_methods=["GET", "POST", "DELETE"],
                   allow_headers=["Authorization", "Content-Type"])


def require_token(authorization: str | None = Header(default=None)) -> None:
    candidate = (authorization or "").removeprefix("Bearer ")
    if not TOKEN or not secrets.compare_digest(candidate, TOKEN):
        raise HTTPException(401, "Credencial local inválida")


def check_origin(origin: str | None) -> None:
    if origin and not EXTENSION_ORIGIN.fullmatch(origin):
        raise HTTPException(403, "Origen no permitido")


@app.get("/health")
def health():
    return {"ok": True, "version": 1}


@app.post("/v1/pair")
async def pair(payload: dict, request: Request):
    global TOKEN, PAIRING_CODE
    check_origin(request.headers.get("origin"))
    address = request.client.host if request.client else "local"
    now = time.monotonic()
    attempts = [when for when in PAIR_ATTEMPTS.get(address, []) if now - when < 60]
    if len(attempts) >= 5:
        raise HTTPException(429, "Esperá un minuto antes de volver a intentar")
    code = str(payload.get("code", ""))
    if len(code) != 6 or not secrets.compare_digest(code, PAIRING_CODE):
        attempts.append(now)
        PAIR_ATTEMPTS[address] = attempts
        await asyncio.sleep(0.5)
        raise HTTPException(401, "Código de emparejamiento incorrecto")
    PAIR_ATTEMPTS.pop(address, None)
    TOKEN = secrets.token_urlsafe(32)
    PAIRING_CODE = f"{secrets.randbelow(1_000_000):06d}"
    save_secret()
    return {"token": TOKEN}


@app.get("/v1/status", dependencies=[Depends(require_token)])
def status():
    active = manager.active
    return {"protocol_version": 1, "session": None if not active else {
        "session_id": active.id, "video_id": active.video_id, "generation": active.generation,
        "state": active.state, "ready_through_ms": active.ready_through_ms,
        "position_ms": active.position_ms, "detail": active.detail},
        "models": {"translation": translator.ready(),
                   "tts": (settings.models / "llama-tts" / "Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf").is_file()
                          and (settings.models / "llama-tts" / "mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf").is_file(),
                   "asr": (settings.models / "faster-whisper-large-v3-turbo").is_dir()},
        "voices": len(list(settings.voices_dir.glob("*.json")))}


@app.get("/v1/voices", dependencies=[Depends(require_token)])
def voices():
    output = []
    for file in settings.voices_dir.glob("*.json"):
        if file.with_suffix(".wav").is_file():
            meta = json.loads(file.read_text(encoding="utf-8"))
            output.append({"id": file.stem, "name": meta.get("name", file.stem)})
    return output


@app.post("/v1/voices", dependencies=[Depends(require_token)])
def import_voice(voice: VoiceImport):
    try:
        data = base64.b64decode(voice.audio_base64, validate=True)
        if len(data) > 15_000_000:
            raise ValueError("Archivo demasiado grande")
        info = sf.info(io.BytesIO(data))
        if not 3 <= info.duration <= 60 or not 8000 <= info.samplerate <= 96000:
            raise ValueError("La voz debe durar entre 3 y 60 segundos")
        waveform, rate = sf.read(io.BytesIO(data), dtype="float32")
        if waveform.ndim == 2:
            waveform = waveform.mean(axis=1)
        if max(abs(waveform)) < 0.01:
            raise ValueError("La muestra está en silencio")
    except Exception as exc:
        raise HTTPException(422, f"Muestra de voz inválida: {exc}") from exc
    audio = settings.voices_dir / "default.wav"
    sf.write(audio, waveform, rate, subtype="PCM_16")
    (settings.voices_dir / "default.json").write_text(
        json.dumps({"name": voice.name, "transcript": voice.transcript,
                    "sha256": hashlib.sha256(audio.read_bytes()).hexdigest()}, ensure_ascii=False), encoding="utf-8")
    return {"id": "default", "name": voice.name}


@app.post("/v1/ws-ticket", dependencies=[Depends(require_token)])
def ticket():
    value = secrets.token_urlsafe(24)
    TICKETS[value] = time.monotonic() + 15
    return {"ticket": value}


@app.websocket("/v1/events")
async def events(websocket: WebSocket):
    origin = websocket.headers.get("origin")
    if origin and not EXTENSION_ORIGIN.fullmatch(origin):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        hello = await asyncio.wait_for(websocket.receive_json(), 3)
        value = str(hello.get("ticket", ""))
        expiry = TICKETS.pop(value, 0)
        if not value or expiry < time.monotonic():
            await websocket.close(code=1008)
            return
        queue = manager.subscribe()
        await websocket.send_json({"type": "hello", "protocol_version": 1,
                                   "session": None if not manager.active else {
                                       "session_id": manager.active.id,
                                       "video_id": manager.active.video_id,
                                       "generation": manager.active.generation,
                                       "state": manager.active.state,
                                       "ready_through_ms": manager.active.ready_through_ms},
                                   "history": manager.history[-100:]})
        while True:
            event = await asyncio.wait_for(queue.get(), timeout=20)
            await websocket.send_json(event)
    except asyncio.TimeoutError:
        try:
            await websocket.send_json({"type": "heartbeat"})
            while True:
                event = await asyncio.wait_for(queue.get(), timeout=20)
                await websocket.send_json(event)
        except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
            pass
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if "queue" in locals():
            manager.unsubscribe(queue)


@app.post("/v1/sessions", dependencies=[Depends(require_token)])
async def start(body: StartRequest):
    try:
        video_id = parse_video_id(body.url)
        session = await manager.start(video_id, body.position_ms, body.speed,
                                      body.source_mode, body.voice_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"session_id": session.id, "video_id": video_id, "generation": session.generation}


@app.post("/v1/sessions/{session_id}/control", dependencies=[Depends(require_token)])
async def control(session_id: str, body: ControlRequest):
    try:
        session = await manager.control(session_id, body.action, body.position_ms, body.speed)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"session_id": session.id, "generation": session.generation, "state": session.state}


@app.post("/v1/sessions/{session_id}/position", dependencies=[Depends(require_token)])
def position(session_id: str, body: dict):
    value = body.get("position_ms")
    if not isinstance(value, int) or value < 0:
        raise HTTPException(422, "Posición inválida")
    manager.update_position(session_id, value)
    return {"ok": True}


@app.get("/v1/audio/{audio_id}", dependencies=[Depends(require_token)])
def audio(audio_id: str):
    found = manager.audio_files.get(audio_id)
    if not re.fullmatch(r"[a-f0-9]{32}", audio_id) or not found or not found[1].is_file():
        raise HTTPException(404, "Audio no encontrado")
    return FileResponse(found[1], media_type="audio/wav", filename="doblaje.wav")
