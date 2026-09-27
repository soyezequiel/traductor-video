from __future__ import annotations

import html
import json
import re

from .types import SourceSegment


TIMESTAMP = re.compile(r"(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})")
TAGS = re.compile(r"<[^>]+>")


def timestamp_ms(value: str) -> int:
    match = TIMESTAMP.search(value)
    if not match:
        raise ValueError(f"Timestamp VTT inválido: {value!r}")
    hours, minutes, seconds, millis = match.groups()
    return ((int(hours or 0) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + int(millis)


def clean_text(value: str) -> str:
    value = re.sub(r"<\d\d:\d\d:\d\d[.,]\d{3}>", "", value)
    value = TAGS.sub("", value)
    value = html.unescape(value)
    return " ".join(value.replace("\u200b", "").split())


def parse_vtt(body: str) -> list[SourceSegment]:
    result: list[SourceSegment] = []
    blocks = re.split(r"\r?\n\s*\r?\n", body.lstrip("\ufeff"))
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        timing = next((i for i, line in enumerate(lines) if "-->" in line), -1)
        if timing < 0:
            continue
        start_raw, end_raw = lines[timing].split("-->", 1)
        try:
            start, end = timestamp_ms(start_raw), timestamp_ms(end_raw)
        except ValueError:
            continue
        content = clean_text(" ".join(lines[timing + 1 :]))
        if content and end > start:
            result.append(SourceSegment(start, end, content))
    return deduplicate(result)


def parse_json3(body: str) -> list[SourceSegment]:
    result: list[SourceSegment] = []
    for event in json.loads(body).get("events", []):
        text = clean_text("".join(part.get("utf8", "") for part in event.get("segs", [])))
        start = int(event.get("tStartMs", 0))
        end = start + int(event.get("dDurationMs", 0))
        if text and end > start:
            result.append(SourceSegment(start, end, text))
    return deduplicate(result)


def deduplicate(items: list[SourceSegment]) -> list[SourceSegment]:
    """Remove repeated progressive captions without deleting spoken repetitions."""
    output: list[SourceSegment] = []
    previous_raw: SourceSegment | None = None
    for item in sorted(items, key=lambda x: (x.start_ms, x.end_ms)):
        if previous_raw and item.start_ms - previous_raw.end_ms <= 150:
            old_words = previous_raw.text.split()
            new_words = item.text.split()
            def normalized(word: str) -> str:
                return re.sub(r"^\W+|\W+$", "", word).casefold()
            old = [normalized(word) for word in old_words]
            new = [normalized(word) for word in new_words]
            common = 0
            for size in range(min(len(old), len(new)), 1, -1):
                if old[-size:] == new[:size]:
                    common = size
                    break
            if common:
                extra = " ".join(new_words[common:])
                if extra and item.start_ms < previous_raw.end_ms and output:
                    last = output[-1]
                    output[-1] = SourceSegment(last.start_ms, max(last.end_ms, item.end_ms),
                                               f"{last.text} {extra}")
                elif extra:
                    output.append(SourceSegment(item.start_ms, item.end_ms, extra))
                previous_raw = item
                continue
        output.append(item)
        previous_raw = item
    return output


def group_sentences(items: list[SourceSegment], max_ms: int = 8500) -> list[SourceSegment]:
    groups: list[SourceSegment] = []
    for item in items:
        if not groups:
            groups.append(item)
            continue
        prev = groups[-1]
        gap = item.start_ms - prev.end_ms
        duration = item.end_ms - prev.start_ms
        if gap < 550 and duration <= max_ms and not re.search(r"[.!?…]$", prev.text):
            common = 0
            prev_words, next_words = prev.text.split(), item.text.split()
            for size in range(min(len(prev_words), len(next_words), 7), 0, -1):
                if prev_words[-size:] == next_words[:size]:
                    common = size
                    break
            extra = " ".join(next_words[common:])
            groups[-1] = SourceSegment(prev.start_ms, max(prev.end_ms, item.end_ms),
                                       f"{prev.text} {extra}".strip())
        else:
            groups.append(item)
    return groups
