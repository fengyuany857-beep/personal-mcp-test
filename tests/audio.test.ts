import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIO_MEASUREMENT_VERSION,
  analyzeWav,
  compareProfiles,
  stemMasking,
} from "../src/audio/analyzer.ts";
import { registerAudioTools, validateHostFileUrl } from "../src/audio/tools.ts";

function wav16(
  sampleRate: number,
  durationSeconds: number,
  channels: number,
  sampleAt: (frame: number, channel: number) => number,
): Uint8Array {
  const frames = Math.floor(sampleRate * durationSeconds);
  const dataBytes = frames * channels * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let p = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(0.999969, sampleAt(frame, channel)));
      view.setInt16(p, Math.round(sample * 32767), true);
      p += 2;
    }
  }
  return new Uint8Array(buffer);
}

function sine(
  frequency: number,
  peakDbfs: number,
  durationSeconds = 4,
  stereoMode: "identical" | "antiphase" = "identical",
): Uint8Array {
  const rate = 48000;
  const amplitude = 10 ** (peakDbfs / 20);
  return wav16(rate, durationSeconds, 2, (frame, channel) => {
    const x = amplitude * Math.sin((2 * Math.PI * frequency * frame) / rate);
    return stereoMode === "antiphase" && channel === 1 ? -x : x;
  });
}

test("48 kHz stereo sine produces defensible level and stereo measurements", () => {
  const profile = analyzeWav(sine(1000, -12), "general");
  assert.equal(profile.measurementVersion, AUDIO_MEASUREMENT_VERSION);
  assert.equal(profile.metadata.sampleRate, 48000);
  assert.equal(profile.metadata.channels, 2);
  assert.ok(Math.abs(profile.level.samplePeakDbfs - (-12)) < 0.15);
  assert.ok(Math.abs(profile.level.rmsDbfs - (-15.01)) < 0.2);
  assert.ok(profile.level.integratedLufs !== null);
  assert.ok((profile.level.integratedLufs as number) > -17);
  assert.ok((profile.level.integratedLufs as number) < -12);
  assert.ok(profile.stereo.correlation !== null && profile.stereo.correlation > 0.999);
  assert.ok(profile.stereo.sideMinusMidDb !== null && profile.stereo.sideMinusMidDb < -100);
  assert.equal(profile.level.truePeakDbtp, null);
  assert.ok(profile.limitations.some((x) => x.includes("true peak")));
});

test("anti-phase stereo is flagged and predicts severe mono loss", () => {
  const profile = analyzeWav(sine(500, -12, 4, "antiphase"), "general");
  assert.ok(profile.stereo.correlation !== null && profile.stereo.correlation < -0.999);
  assert.ok(profile.stereo.monoPowerDeltaDb !== null && profile.stereo.monoPowerDeltaDb < -100);
  assert.ok(profile.findings.some((finding) => finding.code === "negative_stereo_correlation"));
  assert.ok(profile.findings.some((finding) => finding.code === "mono_power_loss"));
});

test("normal periodic sample motion is not mistaken for a loop click", () => {
  const profile = analyzeWav(sine(1000, -6, 1), "general");
  assert.ok(profile.loop.seamJumpDbfs > -30);
  assert.ok(profile.loop.seamJumpVsEdgeStepDb < 12);
  assert.equal(profile.findings.some((finding) => finding.code === "loop_seam_discontinuity"), false);
});

test("an abnormal endpoint step is flagged as a loop seam discontinuity", () => {
  const rate = 48000;
  const bytes = wav16(rate, 1, 2, (frame) => frame === rate - 1 ? 0.8 : 0);
  const profile = analyzeWav(bytes, "general");
  assert.ok(profile.loop.seamJumpVsEdgeStepDb > 12);
  assert.ok(profile.findings.some((finding) => finding.code === "loop_seam_discontinuity"));
});

test("reference comparison detects level-independent spectral differences", () => {
  const mix = analyzeWav(sine(1000, -12), "general");
  const reference = analyzeWav(sine(100, -12), "general");
  const comparison = compareProfiles(mix, reference);
  assert.equal(comparison.measurementVersion, AUDIO_MEASUREMENT_VERSION);
  assert.ok(comparison.notableBands.length >= 2);
  assert.ok(Math.abs(comparison.rmsDeltaDb) < 0.3);
});

test("stem masking ranks similar spectral profiles above unrelated bands", () => {
  const strings = analyzeWav(sine(1000, -18), "general");
  const brass = analyzeWav(sine(1000, -17), "general");
  const bass = analyzeWav(sine(80, -17), "general");
  const result = stemMasking([
    { name: "Strings", profile: strings },
    { name: "Brass", profile: brass },
    { name: "Bass", profile: bass },
  ]);
  assert.equal(result.pairs[0].a, "Strings");
  assert.equal(result.pairs[0].b, "Brass");
  assert.equal(result.pairs[0].spectralOverlapRisk, "high");
});

test("unsupported containers fail closed", () => {
  assert.throws(
    () => analyzeWav(new Uint8Array([1, 2, 3, 4, 5]), "general"),
    /AUDIO_WAV_TOO_SMALL/,
  );
});

test("ChatGPT file URL gate rejects obvious local/private and credentialed targets", () => {
  assert.throws(() => validateHostFileUrl("http://example.com/a.wav"), /AUDIO_FILE_HTTPS_REQUIRED/);
  assert.throws(() => validateHostFileUrl("https://127.0.0.1/a.wav"), /AUDIO_FILE_PRIVATE_TARGET_BLOCKED/);
  assert.throws(() => validateHostFileUrl("https://192.168.1.2/a.wav"), /AUDIO_FILE_PRIVATE_TARGET_BLOCKED/);
  assert.throws(() => validateHostFileUrl("https://user:pass@example.com/a.wav"), /AUDIO_FILE_CREDENTIALS_BLOCKED/);
  assert.equal(validateHostFileUrl("https://files.example.com/a.wav").hostname, "files.example.com");
});

test("public audio surface registers three tools and marks ChatGPT file input", () => {
  const registrations: Array<{ name: string; config: Record<string, unknown> }> = [];
  const fakeServer = { registerTool(name: string, config: Record<string, unknown>) { registrations.push({ name, config }); } };
  registerAudioTools(fakeServer as never);
  assert.deepEqual(registrations.map((x) => x.name).sort(), [
    "audio.analyze_wav", "audio.compare_reference", "audio.stem_masking",
  ]);
  const analyze = registrations.find((x) => x.name === "audio.analyze_wav");
  assert.deepEqual((analyze?.config._meta as Record<string, unknown>)?.["openai/fileParams"], ["audio_file"]);
});
