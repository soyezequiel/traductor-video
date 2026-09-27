from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

from .alignment import align_captions
from .config import settings
from .models import adjust_audio, polish_voice, recognizer, synthesizer, translator, trim_outer_silence
from .source import VideoSource, read_audio_window, resolve
from .types import SourceSegment
from .video_voice import VideoVoice, VoiceSampleUnavailable


log = logging.getLogger(__name__)


def speech_fit(natural_ms: int, available_ms: int) -> float:
    """Speed speech up enough to fit when possible, without exceeding a naturalness cap."""
    return min(1.5, max(1.0, natural_ms / max(400, available_ms - 150)))


@dataclass
class Session:
    id: str
    video_id: str
    position_ms: int
    speed: float
    source_mode: str
    voice_id: str
    generation: int = 1
    state: str = "RESOLVING_SOURCE"
    detail: str = ""
    ready_through_ms: int = 0
    duration_ms: int | None = None
    title: str | None = None
    source: VideoSource | None = None
    task: asyncio.Task | None = None
    _last_progress: float = field(default_factory=time.monotonic)
    voice_cache: OrderedDict = field(default_factory=OrderedDict)
    voice_cache_bytes: int = 0


class SessionManager:
    def __init__(self) -> None:
        self.active: Session | None = None
        self.subscribers: set[asyncio.Queue] = set()
        self.seq = 0
        self.lock = asyncio.Lock()
        self.voice_reference_lock = asyncio.Lock()
        self.audio_files: dict[str, tuple[str, Path]] = {}
        self.history: list[dict] = []

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=300)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.subscribers.discard(queue)

    def emit(self, session: Session, kind: str, payload: dict) -> None:
        self.seq += 1
        event = {"protocol_version": 1, "type": kind, "session_id": session.id,
                 "video_id": session.video_id, "generation": session.generation,
                 "seq": self.seq, "payload": payload}
        self.history.append(event)
        self.history = self.history[-200:]
        for queue in list(self.subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                self.subscribers.discard(queue)

    def state(self, session: Session, value: str, detail: str = "") -> None:
        session.state = value
        session.detail = detail
        self.emit(session, "session_state", {"state": value, "detail": detail})

    async def start(self, video_id: str, position_ms: int, speed: float,
                    source_mode: str, voice_id: str) -> Session:
        async with self.lock:
            if self.active:
                await self._stop(self.active)
            if voice_id != "video":
                voice_path, _ = voice_reference(voice_id)
                if not voice_path.is_file():
                    raise ValueError("VOICE_REQUIRED: Importá una muestra de voz argentina en Opciones")
            session = Session(str(uuid.uuid4()), video_id, position_ms, speed, source_mode, voice_id,
                              ready_through_ms=position_ms)
            self.active = session
            session.task = asyncio.create_task(self._run(session, session.generation))
            return session

    async def _stop(self, session: Session) -> None:
        session.generation += 1
        if session.task:
            session.task.cancel()
            try:
                await session.task
            except asyncio.CancelledError:
                pass
        self.state(session, "STOPPED")
        session.voice_cache.clear()
        session.voice_cache_bytes = 0
        if session.source:
            session.source.close()
            session.source = None
        for key, (owner, _) in list(self.audio_files.items()):
            if owner == session.id:
                _, path = self.audio_files.pop(key)
                path.unlink(missing_ok=True)

    async def control(self, session_id: str, action: str, position_ms: int | None = None,
                      speed: float | None = None) -> Session:
        async with self.lock:
            session = self.active
            if not session or session.id != session_id:
                raise KeyError("Sesión inexistente")
            if action == "stop":
                await self._stop(session)
                self.active = None
                return session
            if position_ms is not None:
                session.position_ms = position_ms
            if action == "speed" and speed is not None:
                session.speed = speed
            if action in {"seek", "speed"}:
                session.generation += 1
                if session.task:
                    session.task.cancel()
                    try:
                        await session.task
                    except asyncio.CancelledError:
                        pass
                session.ready_through_ms = session.position_ms
                session.task = asyncio.create_task(self._run(session, session.generation))
            return session

    def update_position(self, session_id: str, position_ms: int) -> None:
        if self.active and self.active.id == session_id:
            self.active.position_ms = position_ms

    async def _run(self, session: Session, generation: int) -> None:
        video_voice: VideoVoice | None = None
        pending: list[asyncio.Task] = []
        try:
            self.state(session, "RESOLVING_SOURCE", "Buscando el audio y los subtítulos…")
            if session.source is None:
                session.source = await asyncio.to_thread(
                    resolve, session.video_id, session.source_mode == "audio")
            source = session.source
            if generation != session.generation:
                return
            if source.is_live:
                raise RuntimeError("UNSUPPORTED_LIVE: Esta versión dobla videos grabados")
            if session.voice_id == "video":
                if not source.audio_url:
                    raise RuntimeError("SOURCE_UNAVAILABLE: No se puede leer la voz original")
                video_voice = VideoVoice(source)
            session.duration_ms, session.title = source.duration_ms, source.title
            mode = "captions" if source.captions else "audio"
            self.emit(session, "source_info", {"mode": mode, "caption_origin": source.caption_origin,
                                               "duration_ms": source.duration_ms, "title": source.title})
            self.state(session, "BUFFERING", "Preparando la voz del video…")
            if source.captions:
                items = [item for item in source.captions if item.end_ms > session.position_ms]
                alignment_attempted = False
                for index, item in enumerate(items):
                    if item.end_ms <= session.position_ms:
                        continue
                    if source.audio_url and not alignment_attempted and generation == 1:
                        alignment_attempted = True
                        window_start = max(0, item.start_ms - 1000)
                        window_end = min(source.duration_ms or window_start + 12_000,
                                         window_start + 12_000)
                        last = index
                        while last < len(items) and items[last].start_ms < window_end:
                            last += 1
                        try:
                            self.state(session, "BUFFERING", "Sincronizando las primeras frases…")
                            wav = await asyncio.to_thread(read_audio_window, source, window_start,
                                                          window_end - window_start, 4)
                            if video_voice:
                                await asyncio.to_thread(video_voice.ingest, wav, window_start)
                            words = await asyncio.to_thread(recognizer.transcribe_words, wav, window_start)
                            if generation != session.generation:
                                return
                            items[index:last] = align_captions(items[index:last], words)
                        except Exception as exc:
                            log.warning("No se pudieron alinear subtítulos con el audio: %s", exc)
                    item = items[index]
                    await self._wait_for_horizon(session, generation)
                    context = " ".join(it.text for it in items[max(0, index - 3):index])
                    next_start = items[index + 1].start_ms if index + 1 < len(items) else None
                    if len(pending) == 2:
                        await pending[0]
                        pending.pop(0)
                    pending.append(asyncio.create_task(self._produce(
                        session, generation, item, context, next_start, video_voice,
                        commit_after=pending[-1] if pending else None)))
                if pending:
                    await asyncio.gather(*pending)
                    pending.clear()
            else:
                if not source.audio_url:
                    raise RuntimeError("SOURCE_UNAVAILABLE: No se puede leer el audio original")
                cursor = max(0, session.position_ms - 1000)
                while not source.duration_ms or cursor < source.duration_ms:
                    cursor = max(cursor, max(0, session.position_ms - 1000))
                    await self._wait_for_horizon(session, generation)
                    # A smaller first window delivers speech sooner; later windows amortize ASR.
                    window_ms = 12_000 if cursor <= session.position_ms else 30_000
                    duration = min(window_ms, (source.duration_ms or cursor + window_ms) - cursor)
                    if duration <= 0:
                        break
                    self.state(session, "BUFFERING", "Escuchando y traduciendo el audio original…")
                    wav = await asyncio.to_thread(read_audio_window, source, cursor, duration)
                    if video_voice:
                        await asyncio.to_thread(video_voice.ingest, wav, cursor)
                    transcribed = await asyncio.to_thread(recognizer.transcribe, wav, cursor)
                    if generation != session.generation:
                        return
                    previous = ""
                    for index, (start, end, text) in enumerate(transcribed):
                        if end <= session.position_ms or not text:
                            continue
                        next_start = transcribed[index + 1][0] if index + 1 < len(transcribed) else None
                        item = SourceSegment(start, end, text)
                        if len(pending) == 2:
                            await pending[0]
                            pending.pop(0)
                        pending.append(asyncio.create_task(self._produce(
                            session, generation, item, previous, next_start, video_voice,
                            commit_after=pending[-1] if pending else None)))
                        previous = text
                    if pending:
                        await asyncio.gather(*pending)
                        pending.clear()
                    cursor += duration
                    session.ready_through_ms = max(session.ready_through_ms, cursor)
                    self.emit(session, "buffer_status", {"ready_through_ms": session.ready_through_ms})
            if generation == session.generation:
                self.emit(session, "buffer_status", {"ready_through_ms": session.duration_ms or session.ready_through_ms,
                                                     "eof": True})
                self.state(session, "PLAYING")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("Falla en sesión %s", session.id)
            if generation == session.generation:
                self.state(session, "ERROR", str(exc)[:400])
        finally:
            for task in pending:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            if video_voice:
                video_voice.close()

    async def _wait_for_horizon(self, session: Session, generation: int) -> None:
        while session.ready_through_ms > session.position_ms + 60_000:
            await asyncio.sleep(0.2)
            if generation != session.generation:
                raise asyncio.CancelledError

    async def _produce(self, session: Session, generation: int, item: SourceSegment,
                       context: str, next_start_ms: int | None = None,
                       video_voice: VideoVoice | None = None,
                       commit_after: asyncio.Task | None = None) -> None:
        deadline_ms = max(item.end_ms, next_start_ms or item.end_ms)
        if generation != session.generation or deadline_ms <= session.position_ms:
            return
        cache_key = (session.voice_id, item.start_ms, item.end_ms, item.text, context)
        cached = session.voice_cache.get(cache_key)
        if cached is not None:
            session.voice_cache.move_to_end(cache_key)
            translated, wav, sample_rate, natural_ms = cached
        else:
            if video_voice:
                try:
                    async with self.voice_reference_lock:
                        voice_file = await asyncio.to_thread(video_voice.reference_for, item)
                    transcript = item.text
                except VoiceSampleUnavailable:
                    # A silent opening can use the optional local voice if one is installed.
                    voice_file, transcript = voice_reference("default")
                    log.info("Usando voz local de respaldo para la frase en %s ms", item.start_ms)
            else:
                voice_file, transcript = voice_reference(session.voice_id)
            translated = await asyncio.to_thread(translator.translate, item.text, context)
            if generation != session.generation or deadline_ms <= session.position_ms:
                return
            if session.ready_through_ms <= session.position_ms:
                self.state(session, "BUFFERING", "Generando las primeras frases…")
            wav, sample_rate, natural_ms = await asyncio.to_thread(synthesizer.synthesize, translated,
                                                                     voice_file, transcript)
            if generation != session.generation or deadline_ms <= session.position_ms:
                return
            wav, natural_ms = await asyncio.to_thread(trim_outer_silence, wav)
            wav = await asyncio.to_thread(polish_voice, wav)
            if generation != session.generation:
                return
            session.voice_cache[cache_key] = (translated, wav, sample_rate, natural_ms)
            session.voice_cache_bytes += len(wav)
            while session.voice_cache_bytes > 32 * 1024 * 1024:
                _, old = session.voice_cache.popitem(last=False)
                session.voice_cache_bytes -= len(old[1])
        available = max(400, deadline_ms - item.start_ms)
        fit = speech_fit(natural_ms, available)
        render_rate = fit * session.speed
        rendered, rendered_ms = await asyncio.to_thread(adjust_audio, wav, render_rate)
        if generation != session.generation:
            return
        if commit_after is not None:
            await commit_after
            if generation != session.generation:
                return
        audio_id = uuid.uuid4().hex
        file = settings.audio_dir / f"{audio_id}.wav"
        await asyncio.to_thread(file.write_bytes, rendered)
        self.audio_files[audio_id] = (session.id, file)
        self._prune_audio(session)
        self.emit(session, "segment_ready", {"segment_id": audio_id,
                  "start_ms": item.start_ms, "end_ms": item.end_ms,
                  "sync_deadline_ms": deadline_ms,
                  "text_es_ar": translated, "audio_id": audio_id,
                  "sample_rate_hz": sample_rate, "channels": 1,
                  "natural_duration_ms": natural_ms, "rendered_duration_ms": rendered_ms,
                  "render_rate": render_rate,
                  "sha256": hashlib.sha256(rendered).hexdigest()})
        session.ready_through_ms = max(session.ready_through_ms, deadline_ms)
        self.emit(session, "buffer_status", {"ready_through_ms": session.ready_through_ms})

    def _prune_audio(self, session: Session) -> None:
        """Keep only recent and nearby clips; never delete the current playback window."""
        for key, (owner, path) in list(self.audio_files.items()):
            if owner != session.id or key == next(reversed(self.audio_files)):
                continue
            try:
                old = path.stat().st_mtime < time.time() - 600
            except FileNotFoundError:
                old = True
            if old:
                self.audio_files.pop(key, None)
                path.unlink(missing_ok=True)


def voice_reference(voice_id: str) -> tuple[Path, str]:
    if not voice_id.replace("-", "").replace("_", "").isalnum() or len(voice_id) > 60:
        raise ValueError("ID de voz inválido")
    base = settings.voices_dir / voice_id
    meta = base.with_suffix(".json")
    if not meta.is_file():
        raise ValueError("VOICE_REQUIRED: Importá una muestra de voz argentina en Opciones")
    return base.with_suffix(".wav"), str(json.loads(meta.read_text(encoding="utf-8"))["transcript"])


manager = SessionManager()
