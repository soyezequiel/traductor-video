from doblaje.captions import group_sentences, parse_json3, parse_vtt
from doblaje.types import SourceSegment


def test_vtt_progressive_and_real_repetition():
    body = """WEBVTT

00:00:01.000 --> 00:00:02.000
I can

00:00:01.400 --> 00:00:02.700
I can do it

00:00:03.000 --> 00:00:03.800
I can do it
"""
    items = parse_vtt(body)
    assert [(item.start_ms, item.text) for item in items] == [
        (1000, "I can do it"), (3000, "I can do it")]


def test_json3_and_grouping_preserve_timeline():
    body = '{"events":[{"tStartMs":100,"dDurationMs":1000,"segs":[{"utf8":"Hello"}]},{"tStartMs":1100,"dDurationMs":1000,"segs":[{"utf8":"world."}]}]}'
    grouped = group_sentences(parse_json3(body))
    assert grouped == [SourceSegment(100, 2100, "Hello world.")]


def test_subtitle_markup_is_removed():
    body = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<c.colorE5E5E5>They&#39;re here</c>"
    assert parse_vtt(body)[0].text == "They're here"


def test_rolling_youtube_captions_only_add_new_words():
    body = """WEBVTT

00:00:01.630 --> 00:00:01.640
this video was brought to you by War

00:00:01.640 --> 00:00:03.550
this video was brought to you by War Thunder good evening

00:00:03.550 --> 00:00:03.560
War Thunder good evening

00:00:03.560 --> 00:00:05.430
War Thunder good evening I've always thought

00:00:05.430 --> 00:00:05.440
I've always thought

00:00:05.440 --> 00:00:07.350
I've always thought that Half-Life 2 holds up
"""
    grouped = group_sentences(parse_vtt(body))
    assert grouped == [SourceSegment(1630, 7350,
        "this video was brought to you by War Thunder good evening I've always thought "
        "that Half-Life 2 holds up")]
