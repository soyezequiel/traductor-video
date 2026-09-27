import io

import numpy as np
import soundfile as sf

from doblaje.models import polish_voice, trim_outer_silence


def test_trim_tts_padding_preserves_internal_pause():
    rate = 24000
    spoken = 0.3 * np.sin(2 * np.pi * 440 * np.arange(rate * 3 // 10) / rate)
    samples = np.concatenate([
        np.zeros(rate * 18 // 100), spoken,
        np.zeros(rate // 10), spoken,
        np.zeros(rate * 25 // 100),
    ])
    source = io.BytesIO()
    sf.write(source, samples, rate, format="WAV", subtype="PCM_16")

    trimmed, duration_ms = trim_outer_silence(source.getvalue())
    output, sample_rate = sf.read(io.BytesIO(trimmed))

    assert sample_rate == rate
    assert 700 <= duration_ms <= 790
    assert np.max(np.abs(output[:rate // 20])) > 0.1
    assert np.max(np.abs(output[rate * 33 // 100:rate * 40 // 100])) < 0.01


def test_voice_polish_preserves_duration_pitch_and_limits_gain():
    rate = 24000
    tone = np.sin(2 * np.pi * 220 * np.arange(rate) / rate)
    for amplitude in (0.025, 0.9):
        source = io.BytesIO()
        sf.write(source, amplitude * tone, rate, format="WAV", subtype="PCM_16")
        output, output_rate = sf.read(io.BytesIO(polish_voice(source.getvalue())))
        assert output_rate == rate and len(output) == len(tone)
        assert max(abs(output)) <= 0.92
        assert abs(output[0]) < 0.0001 and abs(output[-1]) < 0.0001
        middle = output[rate // 10:-rate // 10]
        assert np.corrcoef(middle, tone[rate // 10:-rate // 10])[0, 1] > 0.999
        rms = np.sqrt(np.mean(middle ** 2))
        original_rms = amplitude / np.sqrt(2)
        assert 0.49 <= rms / original_rms <= 2.01


def test_voice_polish_does_not_amplify_silence():
    source = io.BytesIO()
    sf.write(source, np.zeros(24000), 24000, format="WAV", subtype="PCM_16")
    assert polish_voice(source.getvalue()) == source.getvalue()
