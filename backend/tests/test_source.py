import pytest

from doblaje.source import parse_video_id


def test_remote_seek_timeout_uses_temporary_local_audio(monkeypatch, tmp_path):
    import subprocess
    from types import SimpleNamespace

    from doblaje import source as module

    video = module.VideoSource("test", "Test", 60000, [], "https://example.test/audio",
                               {}, False, None)
    cached = tmp_path / "audio.media"
    cached.write_bytes(b"media")
    calls = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        if video.audio_url in command:
            raise subprocess.TimeoutExpired("ffmpeg", 1)
        return SimpleNamespace(returncode=0, stdout=b"WAV" * 1000, stderr=b"")

    def fake_cache(source):
        source.audio_file = cached
        return cached

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    monkeypatch.setattr(module, "cache_audio", fake_cache)
    assert module.read_audio_window(video, 30000, 6000, 1) == b"WAV" * 1000
    assert module.read_audio_window(video, 36000, 6000, 1) == b"WAV" * 1000
    assert len(calls) == 3
    video.close()
    assert not cached.exists()


@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=9",
    "https://youtu.be/jNQXAC9IVRw",
])
def test_accepted_urls(url):
    assert parse_video_id(url) == "jNQXAC9IVRw"


@pytest.mark.parametrize("url", [
    "http://127.0.0.1:8765/v1/status",
    "https://evil.example/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com.evil.example/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com/watch?v=bad",
])
def test_other_urls_are_not_fetched(url):
    with pytest.raises(ValueError):
        parse_video_id(url)
