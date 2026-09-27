from __future__ import annotations

import json
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import yt_dlp

from .captions import group_sentences, parse_json3, parse_vtt
from .config import settings
from .types import SourceSegment


VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def parse_video_id(url: str) -> str:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host in {"youtube.com", "www.youtube.com", "m.youtube.com"} and parsed.path == "/watch":
        candidate = parse_qs(parsed.query).get("v", [""])[0]
    elif host == "youtu.be":
        candidate = parsed.path.strip("/").split("/")[0]
    else:
        raise ValueError("Solo se admiten enlaces de videos de YouTube")
    if not VIDEO_ID.fullmatch(candidate):
        raise ValueError("ID de video inválido")
    return candidate


@dataclass
class VideoSource:
    video_id: str
    title: str
    duration_ms: int | None
    captions: list[SourceSegment]
    audio_url: str | None
    audio_headers: dict[str, str]
    is_live: bool
    caption_origin: str | None
    audio_file: Path | None = None

    def close(self) -> None:
        if self.audio_file:
            self.audio_file.unlink(missing_ok=True)
            self.audio_file = None


def cache_audio(source: VideoSource) -> Path:
    """Download one temporary copy when FFmpeg cannot seek the remote stream."""
    if source.audio_file and source.audio_file.is_file():
        return source.audio_file
    if not source.audio_url:
        raise RuntimeError("SOURCE_UNAVAILABLE: No se puede leer el audio original")
    settings.audio_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".media", dir=settings.audio_dir, delete=False) as temp:
        target = Path(temp.name)
    try:
        started = time.monotonic()
        total = 0
        headers = {key: value for key, value in source.audio_headers.items()
                   if key.lower() in {"user-agent", "referer", "accept", "accept-language"}}
        # YouTube can throttle an unrestricted GET while answering byte-range
        # requests immediately. Fixed-size ranges also prevent a long hang.
        with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(10.0, connect=5.0)) as client:
            with target.open("wb") as output:
                expected = None
                while expected is None or total < expected:
                    if total > 200_000_000 or time.monotonic() - started > 120:
                        raise RuntimeError("SOURCE_UNAVAILABLE: El audio original tarda demasiado en descargarse")
                    end = total + 1024 * 1024 - 1
                    response = client.get(source.audio_url,
                                          headers={**headers, "Range": f"bytes={total}-{end}"})
                    response.raise_for_status()
                    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)",
                                         response.headers.get("Content-Range", ""))
                    if response.status_code != 206 or not match or int(match[1]) != total:
                        raise RuntimeError("SOURCE_UNAVAILABLE: YouTube no permite leer el audio por partes")
                    expected = int(match[3])
                    if expected > 200_000_000 or len(response.content) != int(match[2]) - total + 1:
                        raise RuntimeError("SOURCE_UNAVAILABLE: El archivo de audio es demasiado grande o incompleto")
                    output.write(response.content)
                    total += len(response.content)
        if total < 1000:
            raise RuntimeError("SOURCE_UNAVAILABLE: El audio original está vacío")
        source.audio_file = target
        return target
    except Exception as exc:
        target.unlink(missing_ok=True)
        if isinstance(exc, RuntimeError):
            raise
        raise RuntimeError("SOURCE_UNAVAILABLE: YouTube no entregó el audio original") from exc


def _pick_captions(info: dict) -> tuple[list[SourceSegment], str | None]:
    for kind in ("subtitles", "automatic_captions"):
        tracks: dict = info.get(kind) or {}
        languages = sorted(lang for lang in tracks if lang.lower().startswith("en"))
        for lang in languages:
            for fmt in ("vtt", "json3"):
                track = next((track for track in tracks[lang] if track.get("ext") == fmt), None)
                if not track or not track.get("url"):
                    continue
                try:
                    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
                        response = ydl.urlopen(track["url"])
                        body = response.read(8_000_001)
                    if len(body) > 8_000_000:
                        continue
                    decoded = body.decode("utf-8-sig", "replace")
                    segments = parse_vtt(decoded) if fmt == "vtt" else parse_json3(decoded)
                    if segments:
                        return group_sentences(segments), f"{kind}:{lang}"
                except Exception:
                    continue
    return [], None


def resolve(video_id: str, want_audio: bool = False) -> VideoSource:
    if not VIDEO_ID.fullmatch(video_id):
        raise ValueError("ID de video inválido")
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True,
            "js_runtimes": {"node": {}},
            "format": "bestaudio/best", "extract_flat": False, "socket_timeout": 20}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    if not info or info.get("id") != video_id:
        raise RuntimeError("YouTube no devolvió metadatos del video")
    live = bool(info.get("is_live") or info.get("live_status") == "is_live")
    captions, origin = ([], None) if want_audio else _pick_captions(info)
    formats = info.get("requested_formats") or [info]
    audio = next((fmt for fmt in formats if fmt.get("url") and fmt.get("acodec") != "none"), None)
    if not audio:
        audio = next((fmt for fmt in reversed(info.get("formats") or [])
                      if fmt.get("url") and fmt.get("acodec") != "none"), None)
    duration = info.get("duration")
    return VideoSource(video_id, str(info.get("title") or video_id),
                       round(float(duration) * 1000) if duration else None,
                       captions, audio.get("url") if audio else None,
                       dict(audio.get("http_headers") or info.get("http_headers") or {}) if audio else {},
                       live, origin)


def read_audio_window(source: VideoSource, start_ms: int, duration_ms: int,
                      timeout_seconds: int = 90) -> bytes:
    """Return 16 kHz mono WAV; fall back to a local copy if remote seeking stalls."""
    if not source.audio_url:
        raise RuntimeError("No hay una pista de audio accesible")
    headers = "".join(f"{name}: {value}\r\n" for name, value in source.audio_headers.items()
                      if name.lower() in {"user-agent", "referer", "accept", "accept-language"})
    for attempt in range(2):
        local = source.audio_file
        command = [settings.ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
        if headers and not local:
            command += ["-headers", headers]
        command += ["-ss", f"{start_ms / 1000:.3f}", "-i", str(local or source.audio_url),
                    "-t", f"{duration_ms / 1000:.3f}", "-vn", "-ac", "1", "-ar", "16000",
                    "-f", "wav", "pipe:1"]
        try:
            proc = subprocess.run(command, capture_output=True,
                                  timeout=timeout_seconds if not local else 30, check=False)
        except subprocess.TimeoutExpired as exc:
            if local:
                raise RuntimeError("SOURCE_UNAVAILABLE: FFmpeg no pudo leer el audio guardado") from exc
            cache_audio(source)
            continue
        if proc.returncode == 0 and len(proc.stdout) >= 1000:
            return proc.stdout
        if local:
            detail = proc.stderr.decode("utf-8", "replace")[-300:]
            raise RuntimeError(f"SOURCE_UNAVAILABLE: FFmpeg no pudo decodificar el audio: {detail}")
        cache_audio(source)
    raise RuntimeError("SOURCE_UNAVAILABLE: No se pudo leer el audio original")
