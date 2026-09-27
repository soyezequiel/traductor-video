from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field


@dataclass(frozen=True)
class SourceSegment:
    start_ms: int
    end_ms: int
    text: str


class StartRequest(BaseModel):
    url: str
    position_ms: int = Field(ge=0)
    speed: float = Field(default=1.0, ge=0.75, le=1.25)
    source_mode: Literal["auto", "audio"] = "auto"
    voice_id: str = "video"


class ControlRequest(BaseModel):
    action: Literal["seek", "speed", "stop"]
    position_ms: int | None = Field(default=None, ge=0)
    speed: float | None = Field(default=None, ge=0.75, le=1.25)


class VoiceImport(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    audio_base64: str
    transcript: str = Field(min_length=1, max_length=500)
