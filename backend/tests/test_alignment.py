from doblaje.alignment import align_captions
from doblaje.types import SourceSegment


def test_caption_start_follows_original_spoken_words():
    captions = [
        SourceSegment(1200, 3360, "All right, so here we are in front of the elephants"),
        SourceSegment(5318, 7974, "the cool thing about these guys"),
    ]
    words = [
        (920, 1400, "Alright"), (1500, 1580, "so"), (1580, 1720, "here"),
        (1720, 1820, "we"), (1820, 2040, "are"), (2040, 2420, "in"),
        (2420, 2500, "front"), (2500, 2560, "of"), (2560, 2660, "the"),
        (2660, 3280, "elephants"), (4720, 5200, "the"), (5200, 5340, "cool"),
        (5340, 5560, "thing"), (5560, 5960, "about"), (5960, 6140, "these"),
        (6140, 6380, "guys"),
    ]

    result = align_captions(captions, words)

    assert result[0] == SourceSegment(920, 3280, captions[0].text)
    assert result[1] == SourceSegment(4720, 6380, captions[1].text)


def test_weak_or_distant_match_preserves_caption_timing():
    caption = SourceSegment(8000, 9500, "a completely different sentence")
    words = [(1000, 1200, "different"), (1200, 1400, "sentence")]
    assert align_captions([caption], words) == [caption]
