import io
from types import SimpleNamespace

import numpy as np
import soundfile as sf

from doblaje import video_voice as module
from doblaje.source import VideoSource
from doblaje.types import SourceSegment


def test_video_voice_uses_each_phrase_without_refetching_window(monkeypatch, tmp_path):
    rate = 16_000
    first = np.sin(2 * np.pi * 180 * np.arange(rate * 3) / rate) * 0.2
    second = np.sin(2 * np.pi * 320 * np.arange(rate * 3) / rate) * 0.2
    audio = np.concatenate((first, second))
    stream = io.BytesIO()
    sf.write(stream, audio, rate, format="WAV", subtype="PCM_16")
    calls = []

    def read(_source, start, duration, timeout):
        calls.append((start, duration, timeout))
        return stream.getvalue()

    monkeypatch.setattr(module, "read_audio_window", read)
    monkeypatch.setattr(module, "settings", SimpleNamespace(audio_dir=tmp_path))
    source = VideoSource("test", "Test", 6000, [], "https://example.test/audio", {}, False, None)
    voice = module.VideoVoice(source)
    try:
        one = voice.reference_for(SourceSegment(0, 3000, "first"))
        two = voice.reference_for(SourceSegment(3000, 6000, "second"))
        one_data, _ = sf.read(one)
        two_data, _ = sf.read(two)
        assert len(calls) == 1
        assert one != two
        assert np.corrcoef(one_data[:rate], two_data[:rate])[0, 1] < 0.1
    finally:
        voice.close()
    assert not one.exists() and not two.exists()


def test_phrase_crossing_window_edge_fetches_enough_voice(monkeypatch, tmp_path):
    rate = 16_000
    stream = io.BytesIO()
    sf.write(stream, np.full(rate * 3, 0.1), rate, format="WAV", subtype="PCM_16")
    calls = []
    def read(_source, start, _duration, _timeout):
        calls.append(start)
        return stream.getvalue()
    monkeypatch.setattr(module, "read_audio_window", read)
    monkeypatch.setattr(module, "settings", SimpleNamespace(audio_dir=tmp_path))
    source = VideoSource("test", "Test", 6000, [], "https://example.test/audio", {}, False, None)
    voice = module.VideoVoice(source)
    try:
        voice.ingest(stream.getvalue(), 0)
        reference = voice.reference_for(SourceSegment(2500, 5500, "crosses edge"))
        data, _ = sf.read(reference)
        assert calls == [2500]
        assert len(data) == rate * 3
    finally:
        voice.close()


def test_silent_or_short_phrase_reuses_last_good_reference(monkeypatch, tmp_path):
    rate = 16000
    audio = np.concatenate([np.sin(np.arange(rate * 2) * .08) * .1, np.zeros(rate * 3)])
    stream = io.BytesIO()
    sf.write(stream, audio, rate, format="WAV")
    monkeypatch.setattr(module, "settings", SimpleNamespace(audio_dir=tmp_path))
    source = VideoSource("test", "Test", 5000, [], "audio", {}, False, None)
    voice = module.VideoVoice(source)
    try:
        voice.ingest(stream.getvalue(), 0)
        good = voice.reference_for(SourceSegment(0, 2000, "A usable phrase"))
        silent = voice.reference_for(SourceSegment(2000, 4000, "Caption over silence"))
        short = voice.reference_for(SourceSegment(4100, 4300, "Brief"))
        assert silent == short == good
        assert good.is_file()
    finally:
        voice.close()


def test_quiet_speaker_reference_is_normalized(monkeypatch, tmp_path):
    rate = 16000
    stream = io.BytesIO()
    sf.write(stream, np.sin(np.arange(rate * 2) * .08) * .006, rate, format="WAV")
    monkeypatch.setattr(module, "settings", SimpleNamespace(audio_dir=tmp_path))
    source = VideoSource("test", "Test", 2000, [], "audio", {}, False, None)
    voice = module.VideoVoice(source)
    try:
        voice.ingest(stream.getvalue(), 0)
        reference = voice.reference_for(SourceSegment(0, 2000, "Quiet voice"))
        samples, _ = sf.read(reference)
        assert np.sqrt(np.mean(samples ** 2)) > .015
        assert np.max(np.abs(samples)) < .92
    finally:
        voice.close()
