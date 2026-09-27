"""Align caption phrases to words spoken in the original audio."""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

from .types import SourceSegment


def _tokens(text: str) -> list[str]:
    ascii_text = unicodedata.normalize("NFKD", text.lower()).encode("ascii", "ignore").decode()
    return re.findall(r"[a-z0-9]+", ascii_text)


def align_captions(items: list[SourceSegment],
                   words: list[tuple[int, int, str]]) -> list[SourceSegment]:
    """Use ordered exact word anchors; keep caption times if the match is weak."""
    caption_tokens: list[str] = []
    caption_origins: list[tuple[int, int]] = []
    sizes: list[int] = []
    for item_index, item in enumerate(items):
        parts = _tokens(item.text)
        sizes.append(len(parts))
        for local_index, part in enumerate(parts):
            caption_tokens.append(part)
            caption_origins.append((item_index, local_index))

    spoken_tokens: list[str] = []
    spoken_origins: list[int] = []
    for word_index, (_, _, text) in enumerate(words):
        for part in _tokens(text):
            spoken_tokens.append(part)
            spoken_origins.append(word_index)
    if not caption_tokens or not spoken_tokens:
        return items

    anchors: list[list[tuple[int, int]]] = [[] for _ in items]
    for block in SequenceMatcher(None, caption_tokens, spoken_tokens, autojunk=False).get_matching_blocks():
        for offset in range(block.size):
            item_index, local_index = caption_origins[block.a + offset]
            anchors[item_index].append((local_index, spoken_origins[block.b + offset]))

    aligned: list[SourceSegment] = []
    for item, matches, size in zip(items, anchors, sizes):
        if len(matches) < min(2, size) or len(matches) / max(1, size) < 0.4:
            aligned.append(item)
            continue
        first_local, first_word = matches[0]
        last_local, last_word = matches[-1]
        first_word = max(0, first_word - min(first_local, 2))
        last_word = min(len(words) - 1, last_word + min(size - last_local - 1, 2))
        start, end = words[first_word][0], words[last_word][1]
        if (end <= start + 150 or abs(start - item.start_ms) > 1600
                or abs(end - item.end_ms) > 2200):
            aligned.append(item)
            continue
        aligned.append(SourceSegment(start, end, item.text))
    return aligned
