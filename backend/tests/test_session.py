import asyncio
import subprocess
import io
from types import SimpleNamespace

import numpy as np
import soundfile as sf

from doblaje import session as module
from doblaje.source import VideoSource
from doblaje.types import SourceSegment


def test_expired_phrase_is_not_synthesized(monkeypatch):
    manager = module.SessionManager()
    active = module.Session(id="test", video_id="test", position_ms=5000, speed=1,
                            source_mode="auto", voice_id="default")
    def unexpected_voice(_voice_id):
        raise AssertionError("A late phrase must not load the voice or synthesize audio")
    monkeypatch.setattr(module, "voice_reference", unexpected_voice)

    asyncio.run(manager._produce(active, active.generation,
                                 SourceSegment(1000, 2000, "Past speech"), "", 3000))

    assert manager.history == []
    assert active.ready_through_ms == 0


def test_speech_fit_speeds_up_without_exceeding_naturalness_cap():
    assert module.speech_fit(3000, 5000) == 1.0
    assert 1.18 < module.speech_fit(6000, 5000) < 1.25
    assert module.speech_fit(13000, 7500) == 1.5


def test_captions_continue_after_alignment_timeout(monkeypatch):
    manager = module.SessionManager()
    active = module.Session(id="test", video_id="test", position_ms=0, speed=1,
                            source_mode="auto", voice_id="default")
    captions = [SourceSegment(start, start + 2000, f"Speech {start}")
                for start in (1000, 31000, 61000)]
    source = VideoSource("test", "Test", 90000, captions, "https://example.test/audio",
                         {}, False, "subtitles:en")
    monkeypatch.setattr(module, "resolve", lambda *_args: source)
    attempts = []
    def slow_audio(_source, _start, _duration, timeout):
        attempts.append(timeout)
        raise subprocess.TimeoutExpired("ffmpeg", timeout)
    monkeypatch.setattr(module, "read_audio_window", slow_audio)
    produced = []
    async def fake_produce(_session, _generation, item, _context, _next_start=None,
                           _video_voice=None, commit_after=None):
        if commit_after is not None:
            await commit_after
        produced.append(item.start_ms)
    monkeypatch.setattr(manager, "_produce", fake_produce)

    asyncio.run(manager._run(active, active.generation))

    assert attempts == [4]
    assert produced == [1000, 31000, 61000]
    assert active.state == "PLAYING"


def test_seek_reuses_resolved_source(monkeypatch):
    manager = module.SessionManager()
    active = module.Session(id="test", video_id="test", position_ms=0, speed=1,
                            source_mode="auto", voice_id="default")
    source = VideoSource("test", "Test", 90000,
                         [SourceSegment(1000, 2000, "First"), SourceSegment(31000, 33000, "Second")],
                         None, {}, False, "subtitles:en")
    resolved = []
    def fake_resolve(*_args):
        resolved.append(True)
        return source
    monkeypatch.setattr(module, "resolve", fake_resolve)
    produced = []
    async def fake_produce(_session, _generation, item, _context, _next_start=None,
                           _video_voice=None, commit_after=None):
        if commit_after is not None:
            await commit_after
        produced.append(item.start_ms)
    monkeypatch.setattr(manager, "_produce", fake_produce)

    asyncio.run(manager._run(active, active.generation))
    active.generation += 1
    active.position_ms = 30000
    asyncio.run(manager._run(active, active.generation))

    assert len(resolved) == 1
    assert produced == [1000, 31000, 31000]


def test_caption_generation_overlaps_but_commits_in_order(monkeypatch):
    manager = module.SessionManager()
    active = module.Session(id="test", video_id="test", position_ms=0, speed=1,
                            source_mode="auto", voice_id="default")
    captions = [SourceSegment(start, start + 1500, f"Speech {start}")
                for start in (1000, 4000, 7000, 10000)]
    source = VideoSource("test", "Test", 15000, captions, None, {}, False, "subtitles:en")
    monkeypatch.setattr(module, "resolve", lambda *_args: source)
    running = 0
    peak = 0
    committed = []

    async def fake_produce(_session, _generation, item, _context, _next_start=None,
                           _video_voice=None, commit_after=None):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.02 if item.start_ms in (1000, 7000) else 0.005)
        running -= 1
        if commit_after is not None:
            await commit_after
        committed.append(item.start_ms)

    monkeypatch.setattr(manager, "_produce", fake_produce)
    asyncio.run(manager._run(active, active.generation))

    assert peak == 2
    assert committed == [1000, 4000, 7000, 10000]
    assert active.state == "PLAYING"


def test_next_phrase_starts_while_previous_phrase_is_still_running(monkeypatch):
    manager = module.SessionManager()
    active = module.Session(id="test", video_id="test", position_ms=0, speed=1,
                            source_mode="auto", voice_id="default")
    captions = [SourceSegment(start, start + 1500, "Speech") for start in (1000, 4000, 7000)]
    active.source = VideoSource("test", "Test", 9000, captions, None, {}, False, "subtitles:en")

    async def run():
        third_started = asyncio.Event()
        async def produce(_session, _generation, item, *_args, commit_after=None):
            if item.start_ms == 4000:
                await asyncio.wait_for(third_started.wait(), timeout=1)
            if item.start_ms == 7000:
                third_started.set()
            if commit_after:
                await commit_after
        monkeypatch.setattr(manager, "_produce", produce)
        await manager._run(active, active.generation)
        assert third_started.is_set()
        assert active.state == "PLAYING"
    asyncio.run(run())


def test_cached_voice_is_reused_and_refitted_after_speed_change(monkeypatch, tmp_path):
    manager = module.SessionManager()
    active = module.Session(id="test", video_id="test", position_ms=0, speed=1,
                            source_mode="auto", voice_id="default")
    stream = io.BytesIO()
    sf.write(stream, .15 * np.sin(np.arange(24000) * .05), 24000, format="WAV")
    synthesized, rates = [], []
    monkeypatch.setattr(module, "settings", SimpleNamespace(audio_dir=tmp_path))
    monkeypatch.setattr(module, "voice_reference", lambda _: (tmp_path / "voice.wav", "Reference"))
    monkeypatch.setattr(module.translator, "translate", lambda *_: "Una frase")
    def synthesize(*_args):
        synthesized.append(True)
        return stream.getvalue(), 24000, 1000
    monkeypatch.setattr(module.synthesizer, "synthesize", synthesize)
    def adjust(wav, speed):
        rates.append(speed)
        return wav, round(1000 / speed)
    monkeypatch.setattr(module, "adjust_audio", adjust)
    item = SourceSegment(0, 3000, "A phrase")
    asyncio.run(manager._produce(active, 1, item, ""))
    active.generation = 2
    active.speed = 1.25
    asyncio.run(manager._produce(active, 2, item, ""))
    assert len(synthesized) == 1
    assert rates == [1, 1.25]
    assert active.voice_cache_bytes > 0
    asyncio.run(manager._stop(active))
    assert active.voice_cache_bytes == 0 and not active.voice_cache
