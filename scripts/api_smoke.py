"""Real backend integration test against the short public YouTube video."""
from __future__ import annotations

import asyncio
import argparse
import io
import json
import sys
import time
from pathlib import Path

import httpx
import soundfile as sf
import websockets


ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8765"


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-mode", choices=["auto", "audio"], default="auto")
    args = parser.parse_args()
    pairing = json.loads((ROOT / "data" / "pairing.json").read_text(encoding="utf-8"))
    async with httpx.AsyncClient(timeout=30) as client:
        token = pairing.get("token")
        if not token:
            answer = await client.post(BASE + "/v1/pair", json={"code": pairing["code"]})
            answer.raise_for_status()
            token = answer.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        ticket = (await client.post(BASE + "/v1/ws-ticket", headers=headers)).json()["ticket"]
        async with websockets.connect("ws://127.0.0.1:8765/v1/events") as ws:
            await ws.send(json.dumps({"ticket": ticket}))
            hello = json.loads(await ws.recv())
            assert hello["type"] == "hello"
            started = await client.post(BASE + "/v1/sessions", headers=headers,
                json={"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                      "position_ms": 0, "speed": 1, "source_mode": args.source_mode, "voice_id": "default"})
            started.raise_for_status()
            session = started.json()
            begin = time.perf_counter()
            try:
                while time.perf_counter() - begin < 120:
                    event = json.loads(await asyncio.wait_for(ws.recv(), timeout=45))
                    if event.get("session_id") != session["session_id"]:
                        continue
                    if event["type"] == "session_state" and event["payload"]["state"] == "ERROR":
                        raise RuntimeError(event["payload"].get("detail", "Error de sesión"))
                    if event["type"] != "segment_ready":
                        continue
                    payload = event["payload"]
                    audio = await client.get(BASE + f"/v1/audio/{payload['audio_id']}", headers=headers)
                    audio.raise_for_status()
                    info = sf.info(io.BytesIO(audio.content))
                    assert info.duration > 0.2
                    assert payload["sample_rate_hz"] == info.samplerate
                    assert payload["channels"] == info.channels
                    assert payload["sync_deadline_ms"] >= payload["end_ms"]
                    report = {"session_id": session["session_id"], "video_id": session["video_id"],
                              "source_mode": args.source_mode,
                              "first_segment_s": round(time.perf_counter() - begin, 2),
                              "start_ms": payload["start_ms"], "end_ms": payload["end_ms"],
                              "sync_deadline_ms": payload["sync_deadline_ms"],
                              "translation": payload["text_es_ar"], "audio_duration_s": info.duration,
                              "sample_rate": info.samplerate}
                    folder = ROOT / "reports"
                    folder.mkdir(exist_ok=True)
                    suffix = "api-smoke-audio" if args.source_mode == "audio" else "api-smoke"
                    (folder / f"{suffix}.wav").write_bytes(audio.content)
                    (folder / f"{suffix}.json").write_text(
                        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
                    print(json.dumps(report, indent=2, ensure_ascii=False))
                    return
                raise TimeoutError("No se recibió audio doblado en dos minutos")
            finally:
                await client.post(BASE + f"/v1/sessions/{session['session_id']}/control",
                    headers=headers, json={"action": "stop"})


if __name__ == "__main__":
    asyncio.run(main())
