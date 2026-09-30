# Audio Mix Analysis

Lattice exposes a bounded, read-only audio measurement surface for mix review.

## MCP tools

### `audio.analyze_wav`

Input: `audio_file`, a ChatGPT/MCP file parameter containing `download_url`, `file_id`, and optional MIME/name metadata. ChatGPT can pass an uploaded WAV directly. The server fetches the authorized temporary URL once and does not expose that URL in its result.

Optional `use_case`: `general`, `game_bgm`, or `showreel`.

V1 accepts mono/stereo RIFF/WAVE PCM 16/24/32-bit or IEEE float32. Decoding is bounded to 3,000,000 frames and 20 MiB fetch payloads.

Measured output includes sample peak, RMS, crest factor, DC offset, clipped-sample rate, K-weighted gated integrated loudness, short-term loudness, LRA-style gated range, stereo correlation, M/S ratio, mono power delta, bounded FFT band energy, per-band M/S width, and loop-boundary evidence.

V1 intentionally returns `truePeakDbtp: null`; it does not pretend sample peak is inter-sample true peak.

### `audio.compare_reference`

Compares two profiles returned by `audio.analyze_wav`. A reference is comparison evidence, not an automatic EQ target.

### `audio.stem_masking`

Consumes 2–12 compact stem profiles and ranks spectral-overlap risk. The result is an overlap proxy, not proof of psychoacoustic masking.

## Intended game-orchestral workflow

Analyze the full mix and reference, compare profiles, analyze exported orchestral stems such as Strings/Winds/Brass/Percussion/Keys/Choir/Room, run `audio.stem_masking`, translate measured findings into DAW actions, then re-export and measure again.

This module is read-only. It does not change FL Studio, plugin parameters, or audio files.

## Known limits

- No inter-sample true-peak meter in V1.
- Spectral analysis is bounded/sampled for Worker cost.
- Only mono/stereo WAV is accepted in V1.
- ChatGPT file downloads are single-hop HTTPS and do not follow redirects.
- Profile masking is not a synchronized multitrack psychoacoustic model.
