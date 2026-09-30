export const AUDIO_MEASUREMENT_VERSION = "lattice-audio-v1" as const;

const EPS = 1e-15;
const MAX_DECODED_FRAMES = 3_000_000;
const BANDS = [
  { id: "sub_20_60", low: 20, high: 60 },
  { id: "bass_60_120", low: 60, high: 120 },
  { id: "low_mid_120_250", low: 120, high: 250 },
  { id: "body_250_500", low: 250, high: 500 },
  { id: "mid_500_1000", low: 500, high: 1000 },
  { id: "presence_1k_2k", low: 1000, high: 2000 },
  { id: "attack_2k_4k", low: 2000, high: 4000 },
  { id: "clarity_4k_8k", low: 4000, high: 8000 },
  { id: "air_8k_16k", low: 8000, high: 16000 },
  { id: "ultra_16k_20k", low: 16000, high: 20000 },
] as const;

export type UseCase = "general" | "game_bgm" | "showreel";
export type Severity = "info" | "review" | "warning";

export interface AudioBandProfile {
  id: string;
  lowHz: number;
  highHz: number;
  energyPct: number;
  relativeDb: number;
  sideMinusMidDb: number | null;
}

export interface AudioFinding {
  code: string;
  severity: Severity;
  evidence: Record<string, number | string | boolean | null>;
  interpretation: string;
}

export interface AudioProfile {
  measurementVersion: typeof AUDIO_MEASUREMENT_VERSION;
  metadata: {
    format: "PCM" | "IEEE_FLOAT";
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    frames: number;
    durationSeconds: number;
  };
  level: {
    samplePeakDbfs: number;
    truePeakDbtp: null;
    integratedLufs: number | null;
    rmsDbfs: number;
    dcOffsetMax: number;
    clippedSamplePct: number;
  };
  dynamics: {
    crestFactorDb: number;
    loudnessRangeLu: number | null;
    shortTermLufs: {
      min: number;
      p10: number;
      median: number;
      p90: number;
      max: number;
    } | null;
  };
  stereo: {
    available: boolean;
    correlation: number | null;
    sideMinusMidDb: number | null;
    monoPowerDeltaDb: number | null;
  };
  spectral: {
    method: "bounded_welch_fft";
    fftSize: number;
    windowsAnalyzed: number;
    centroidHz: number;
    bands: AudioBandProfile[];
  };
  loop: {
    seamJumpDbfs: number;
    seamJumpVsEdgeStepDb: number;
    edgeRmsDeltaDb: number;
  };
  findings: AudioFinding[];
  limitations: string[];
}

interface ParsedWav {
  format: "PCM" | "IEEE_FLOAT";
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  frames: number;
  samples: Float32Array[];
}

function db10(value: number): number {
  return 10 * Math.log10(Math.max(value, EPS));
}

function db20(value: number): number {
  return 20 * Math.log10(Math.max(Math.abs(value), Math.sqrt(EPS)));
}

function finite(value: number, fallback = -120): number {
  return Number.isFinite(value) ? value : fallback;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] === undefined
    ? sorted[base]
    : sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function readAscii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let i = 0; i < length; i += 1) value += String.fromCharCode(view.getUint8(offset + i));
  return value;
}

export function parseWav(bytes: Uint8Array): ParsedWav {
  if (bytes.byteLength < 44) throw new Error("AUDIO_WAV_TOO_SMALL");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("AUDIO_UNSUPPORTED_CONTAINER");
  }

  let offset = 12;
  let fmtOffset = -1;
  let fmtSize = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > view.byteLength) throw new Error("AUDIO_TRUNCATED_CHUNK");
    if (id === "fmt ") {
      fmtOffset = body;
      fmtSize = size;
    } else if (id === "data") {
      dataOffset = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }

  if (fmtOffset < 0 || dataOffset < 0 || fmtSize < 16) throw new Error("AUDIO_MISSING_WAV_CHUNKS");
  const rawFormat = view.getUint16(fmtOffset, true);
  const channels = view.getUint16(fmtOffset + 2, true);
  const sampleRate = view.getUint32(fmtOffset + 4, true);
  const blockAlign = view.getUint16(fmtOffset + 12, true);
  const bitsPerSample = view.getUint16(fmtOffset + 14, true);

  let formatCode = rawFormat;
  if (rawFormat === 0xfffe && fmtSize >= 40) {
    formatCode = view.getUint16(fmtOffset + 24, true);
  }
  const format = formatCode === 1 ? "PCM" : formatCode === 3 ? "IEEE_FLOAT" : null;
  if (!format) throw new Error("AUDIO_UNSUPPORTED_WAV_ENCODING");
  if (channels < 1 || channels > 2) throw new Error("AUDIO_ONLY_MONO_STEREO_SUPPORTED");
  if (sampleRate < 8000 || sampleRate > 192000) throw new Error("AUDIO_UNSUPPORTED_SAMPLE_RATE");
  if (!blockAlign) throw new Error("AUDIO_INVALID_BLOCK_ALIGN");
  const frames = Math.floor(dataSize / blockAlign);
  if (frames < 1) throw new Error("AUDIO_EMPTY_WAV");
  if (frames > MAX_DECODED_FRAMES) throw new Error("AUDIO_FRAME_LIMIT_EXCEEDED");

  const supported =
    (format === "PCM" && [16, 24, 32].includes(bitsPerSample)) ||
    (format === "IEEE_FLOAT" && bitsPerSample === 32);
  if (!supported) throw new Error("AUDIO_UNSUPPORTED_BIT_DEPTH");

  const samples = Array.from({ length: channels }, () => new Float32Array(frames));
  const bytesPerSample = bitsPerSample / 8;

  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const p = dataOffset + frame * blockAlign + channel * bytesPerSample;
      let sample: number;
      if (format === "IEEE_FLOAT") {
        sample = view.getFloat32(p, true);
      } else if (bitsPerSample === 16) {
        sample = view.getInt16(p, true) / 32768;
      } else if (bitsPerSample === 24) {
        let raw = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
        if (raw & 0x800000) raw |= 0xff000000;
        sample = raw / 8388608;
      } else {
        sample = view.getInt32(p, true) / 2147483648;
      }
      samples[channel][frame] = Number.isFinite(sample) ? Math.max(-4, Math.min(4, sample)) : 0;
    }
  }

  return { format, sampleRate, channels, bitsPerSample, frames, samples };
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function highShelf(gainDb: number, q: number, fc: number, rate: number): Biquad {
  const A = 10 ** (gainDb / 40);
  const w0 = 2 * Math.PI * (fc / rate);
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const rootA = Math.sqrt(A);
  const b0 = A * ((A + 1) + (A - 1) * cos + 2 * rootA * alpha);
  const b1 = -2 * A * ((A - 1) + (A + 1) * cos);
  const b2 = A * ((A + 1) + (A - 1) * cos - 2 * rootA * alpha);
  const a0 = (A + 1) - (A - 1) * cos + 2 * rootA * alpha;
  const a1 = 2 * ((A - 1) - (A + 1) * cos);
  const a2 = (A + 1) - (A - 1) * cos - 2 * rootA * alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function highPass(q: number, fc: number, rate: number): Biquad {
  const w0 = 2 * Math.PI * (fc / rate);
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const b0 = (1 + cos) / 2;
  const b1 = -(1 + cos);
  const b2 = (1 + cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function applyBiquad(input: Float32Array, c: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function kWeight(samples: Float32Array[], rate: number): Float32Array[] {
  // The filter topology and constants follow pyloudnorm's MIT-licensed
  // K-weighting implementation (RBJ high shelf + high pass).
  const shelf = highShelf(4.0, 1 / Math.sqrt(2), 1500, rate);
  const hp = highPass(0.5, 38, rate);
  return samples.map((channel) => applyBiquad(applyBiquad(channel, shelf), hp));
}

function slidingBlockPowers(
  weighted: Float32Array[],
  rate: number,
  blockSeconds: number,
  stepSeconds: number,
  padSeconds = 0,
): number[][] {
  const block = Math.max(1, Math.floor(blockSeconds * rate));
  const step = Math.max(1, Math.floor(stepSeconds * rate));
  const frames = weighted[0].length;
  const effectiveFrames = frames + Math.floor(padSeconds * rate);
  if (effectiveFrames < block) return weighted.map(() => []);

  const sums = weighted.map((channel) => {
    let sum = 0;
    const limit = Math.min(block, frames);
    for (let i = 0; i < limit; i += 1) sum += channel[i] * channel[i];
    return sum;
  });
  const powers = weighted.map(() => [] as number[]);

  for (let start = 0; start + block <= effectiveFrames; start += step) {
    for (let ch = 0; ch < weighted.length; ch += 1) powers[ch].push(sums[ch] / block);
    const nextStart = start + step;
    if (nextStart + block > effectiveFrames) break;
    for (let ch = 0; ch < weighted.length; ch += 1) {
      const signal = weighted[ch];
      const removeEnd = Math.min(start + step, frames);
      for (let i = Math.min(start, frames); i < removeEnd; i += 1) {
        sums[ch] -= signal[i] * signal[i];
      }
      const addStart = Math.min(start + block, frames);
      const addEnd = Math.min(nextStart + block, frames);
      for (let i = addStart; i < addEnd; i += 1) {
        sums[ch] += signal[i] * signal[i];
      }
      if (Math.abs(sums[ch]) < EPS) sums[ch] = 0;
    }
  }
  return powers;
}

function blockLoudness(
  weighted: Float32Array[],
  rate: number,
  blockSeconds: number,
  stepSeconds: number,
  padSeconds = 0,
): number[] {
  const powers = slidingBlockPowers(weighted, rate, blockSeconds, stepSeconds, padSeconds);
  if (!powers[0].length) return [];
  return powers[0].map((_, index) => {
    let total = 0;
    for (let ch = 0; ch < powers.length; ch += 1) total += powers[ch][index];
    return -0.691 + db10(total);
  });
}

function integratedLoudness(weighted: Float32Array[], rate: number): number | null {
  const powers = slidingBlockPowers(weighted, rate, 0.4, 0.1);
  if (!powers[0].length) return null;
  const loudness = powers[0].map((_, index) => {
    let total = 0;
    for (let ch = 0; ch < powers.length; ch += 1) total += powers[ch][index];
    return -0.691 + db10(total);
  });

  let selected = loudness.map((v, i) => ({ v, i })).filter(({ v }) => v >= -70);
  if (!selected.length) return null;

  let absolutePower = 0;
  for (let ch = 0; ch < powers.length; ch += 1) {
    absolutePower += selected.reduce((sum, x) => sum + powers[ch][x.i], 0) / selected.length;
  }
  const relativeGate = -0.691 + db10(absolutePower) - 10;
  selected = selected.filter(({ v }) => v > relativeGate && v > -70);
  if (!selected.length) return null;

  let gatedPower = 0;
  for (let ch = 0; ch < powers.length; ch += 1) {
    gatedPower += selected.reduce((sum, x) => sum + powers[ch][x.i], 0) / selected.length;
  }
  return -0.691 + db10(gatedPower);
}

function loudnessRange(shortTerm: number[]): number | null {
  const absolute = shortTerm.filter((v) => v >= -70);
  if (absolute.length < 2) return null;
  const meanPower = absolute.reduce((sum, v) => sum + 10 ** (v / 10), 0) / absolute.length;
  const relativeGate = db10(meanPower) - 20;
  const gated = absolute.filter((v) => v >= relativeGate);
  if (gated.length < 2) return null;
  return percentile(gated, 0.95) - percentile(gated, 0.10);
}

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    const wLenR = Math.cos(angle);
    const wLenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const even = i + k;
        const odd = even + len / 2;
        const vr = re[odd] * wr - im[odd] * wi;
        const vi = re[odd] * wi + im[odd] * wr;
        const ur = re[even], ui = im[even];
        re[even] = ur + vr; im[even] = ui + vi;
        re[odd] = ur - vr; im[odd] = ui - vi;
        const nextWr = wr * wLenR - wi * wLenI;
        wi = wr * wLenI + wi * wLenR;
        wr = nextWr;
      }
    }
  }
}

function spectrum(parsed: ParsedWav): AudioProfile["spectral"] {
  const fftSize = parsed.sampleRate >= 88200 ? 4096 : 2048;
  const windows = Math.min(48, Math.max(1, Math.floor(parsed.frames / fftSize)));
  const monoPower = new Float64Array(fftSize / 2 + 1);
  const midPower = new Float64Array(fftSize / 2 + 1);
  const sidePower = new Float64Array(fftSize / 2 + 1);

  for (let w = 0; w < windows; w += 1) {
    const maxStart = Math.max(0, parsed.frames - fftSize);
    const start = windows === 1 ? 0 : Math.floor((w / (windows - 1)) * maxStart);
    const mono = new Float64Array(fftSize);
    const mid = new Float64Array(fftSize);
    const side = new Float64Array(fftSize);
    const im0 = new Float64Array(fftSize);
    const im1 = new Float64Array(fftSize);
    const im2 = new Float64Array(fftSize);

    for (let i = 0; i < fftSize; i += 1) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
      const l = parsed.samples[0][start + i] ?? 0;
      const r = parsed.channels === 2 ? parsed.samples[1][start + i] ?? 0 : l;
      mono[i] = ((l + r) * 0.5) * window;
      mid[i] = ((l + r) / Math.sqrt(2)) * window;
      side[i] = ((l - r) / Math.sqrt(2)) * window;
    }
    fftInPlace(mono, im0);
    fftInPlace(mid, im1);
    fftInPlace(side, im2);
    for (let k = 0; k < monoPower.length; k += 1) {
      monoPower[k] += mono[k] * mono[k] + im0[k] * im0[k];
      midPower[k] += mid[k] * mid[k] + im1[k] * im1[k];
      sidePower[k] += side[k] * side[k] + im2[k] * im2[k];
    }
  }

  const nyquist = parsed.sampleRate / 2;
  let total = 0;
  let centroidNumerator = 0;
  for (let k = 0; k < monoPower.length; k += 1) {
    const hz = (k * parsed.sampleRate) / fftSize;
    if (hz < 20 || hz > Math.min(20000, nyquist)) continue;
    total += monoPower[k];
    centroidNumerator += hz * monoPower[k];
  }

  const bands = BANDS.map((band) => {
    let power = 0, mid = 0, side = 0;
    const high = Math.min(band.high, nyquist);
    for (let k = 0; k < monoPower.length; k += 1) {
      const hz = (k * parsed.sampleRate) / fftSize;
      if (hz < band.low || hz >= high) continue;
      power += monoPower[k];
      mid += midPower[k];
      side += sidePower[k];
    }
    const pct = total > 0 ? (power / total) * 100 : 0;
    return {
      id: band.id,
      lowHz: band.low,
      highHz: high,
      energyPct: round(pct, 3),
      relativeDb: round(db10(power / Math.max(total, EPS)), 3),
      sideMinusMidDb: parsed.channels === 2 ? round(finite(db10(side / Math.max(mid, EPS))), 3) : null,
    };
  }).filter((band) => band.highHz > band.lowHz);

  return {
    method: "bounded_welch_fft",
    fftSize,
    windowsAnalyzed: windows,
    centroidHz: round(total > 0 ? centroidNumerator / total : 0, 1),
    bands,
  };
}

function basicMeasurements(parsed: ParsedWav) {
  let peak = 0;
  let sumSq = 0;
  let sampleCount = 0;
  let clipped = 0;
  let maxDc = 0;
  const dcSums = new Array(parsed.channels).fill(0);

  let sumL2 = 0, sumR2 = 0, sumLR = 0, sumMid2 = 0, sumSide2 = 0, sumMono2 = 0;
  for (let i = 0; i < parsed.frames; i += 1) {
    const l = parsed.samples[0][i];
    const r = parsed.channels === 2 ? parsed.samples[1][i] : l;
    for (let ch = 0; ch < parsed.channels; ch += 1) {
      const x = parsed.samples[ch][i];
      peak = Math.max(peak, Math.abs(x));
      sumSq += x * x;
      dcSums[ch] += x;
      if (Math.abs(x) >= 0.999) clipped += 1;
      sampleCount += 1;
    }
    if (parsed.channels === 2) {
      sumL2 += l * l;
      sumR2 += r * r;
      sumLR += l * r;
      const mid = (l + r) / Math.sqrt(2);
      const side = (l - r) / Math.sqrt(2);
      sumMid2 += mid * mid;
      sumSide2 += side * side;
      const mono = (l + r) * 0.5;
      sumMono2 += mono * mono;
    }
  }
  for (const sum of dcSums) maxDc = Math.max(maxDc, Math.abs(sum / parsed.frames));

  const rms = Math.sqrt(sumSq / Math.max(1, sampleCount));
  const stereoPower = parsed.channels === 2 ? (sumL2 + sumR2) / (2 * parsed.frames) : rms * rms;
  const monoPower = parsed.channels === 2 ? sumMono2 / parsed.frames : rms * rms;

  return {
    peak,
    rms,
    dc: maxDc,
    clippedPct: (clipped / Math.max(1, sampleCount)) * 100,
    correlation: parsed.channels === 2 ? sumLR / Math.sqrt(Math.max(EPS, sumL2 * sumR2)) : null,
    sideMinusMidDb: parsed.channels === 2 ? db10(sumSide2 / Math.max(sumMid2, EPS)) : null,
    monoPowerDeltaDb: parsed.channels === 2 ? db10(monoPower / Math.max(stereoPower, EPS)) : null,
  };
}

function loopMeasurements(parsed: ParsedWav): AudioProfile["loop"] {
  let jump = 0;
  const localSteps: number[] = [];
  const edgeFrames = Math.min(parsed.frames, Math.max(2, Math.floor(parsed.sampleRate * 0.05)));
  let startSq = 0, endSq = 0, count = 0;

  for (let ch = 0; ch < parsed.channels; ch += 1) {
    const signal = parsed.samples[ch];
    jump = Math.max(jump, Math.abs(signal[signal.length - 1] - signal[0]));
    for (let i = 0; i < edgeFrames; i += 1) {
      startSq += signal[i] * signal[i];
      const endIndex = signal.length - edgeFrames + i;
      endSq += signal[endIndex] * signal[endIndex];
      count += 1;
      if (i > 0) {
        localSteps.push(Math.abs(signal[i] - signal[i - 1]));
        localSteps.push(Math.abs(signal[endIndex] - signal[endIndex - 1]));
      }
    }
  }
  const startRms = Math.sqrt(startSq / Math.max(1, count));
  const endRms = Math.sqrt(endSq / Math.max(1, count));
  const typicalEdgeStep = percentile(localSteps, 0.95);
  return {
    seamJumpDbfs: round(finite(db20(jump)), 3),
    seamJumpVsEdgeStepDb: round(finite(db20(jump / Math.max(typicalEdgeStep, Math.sqrt(EPS)))), 3),
    edgeRmsDeltaDb: round(finite(db20(endRms / Math.max(startRms, Math.sqrt(EPS)))), 3),
  };
}

function deriveFindings(profile: Omit<AudioProfile, "findings" | "limitations">, useCase: UseCase): AudioFinding[] {
  const findings: AudioFinding[] = [];
  const add = (code: string, severity: Severity, evidence: AudioFinding["evidence"], interpretation: string) =>
    findings.push({ code, severity, evidence, interpretation });

  if (profile.level.clippedSamplePct > 0.0001) {
    add("sample_clipping", "warning", { clippedSamplePct: profile.level.clippedSamplePct },
      "Samples reached the clipping threshold. Inspect upstream gain/limiting before interpreting tonal balance.");
  }
  if (profile.level.dcOffsetMax > 0.01) {
    add("dc_offset", "review", { dcOffsetMax: profile.level.dcOffsetMax },
      "A measurable DC offset is present and may waste headroom.");
  }
  if (profile.dynamics.crestFactorDb < 6) {
    add("low_crest_factor", "review", { crestFactorDb: profile.dynamics.crestFactorDb },
      "Peak-to-average contrast is low. This can be intentional, but it is consistent with dense limiting/compression.");
  }
  if (profile.stereo.available && profile.stereo.correlation !== null && profile.stereo.correlation < 0) {
    add("negative_stereo_correlation", "warning", { correlation: profile.stereo.correlation },
      "Average L/R correlation is negative, which raises mono-compatibility risk.");
  }
  if (profile.stereo.available && profile.stereo.monoPowerDeltaDb !== null && profile.stereo.monoPowerDeltaDb < -2) {
    add("mono_power_loss", "warning", { monoPowerDeltaDb: profile.stereo.monoPowerDeltaDb },
      "Summing to mono loses substantial power; inspect phase-dependent widening and ambience.");
  }
  const low = profile.spectral.bands.filter((band) => band.lowHz < 120 && band.sideMinusMidDb !== null);
  if (low.length) {
    const weighted = low.reduce((sum, band) => sum + (band.sideMinusMidDb ?? -120) * Math.max(band.energyPct, 0.01), 0) /
      low.reduce((sum, band) => sum + Math.max(band.energyPct, 0.01), 0);
    if (weighted > -6) {
      add("wide_low_end", "review", { lowBandSideMinusMidDb: round(weighted, 2) },
        "Low-frequency side energy is relatively strong. This is not automatically wrong, but it deserves a mono and translation check.");
    }
  }
  if (profile.loop.seamJumpDbfs > -35 && profile.loop.seamJumpVsEdgeStepDb > 12) {
    add("loop_seam_discontinuity", "warning", {
      seamJumpDbfs: profile.loop.seamJumpDbfs,
      seamJumpVsEdgeStepDb: profile.loop.seamJumpVsEdgeStepDb,
    }, "The loop-boundary step is much larger than normal local edge-to-edge sample motion. This is a stronger click/pop indicator than raw endpoint mismatch alone.");
  }
  if (profile.level.integratedLufs !== null) {
    const threshold = useCase === "game_bgm" ? -11.5 : useCase === "showreel" ? -8 : -9;
    if (profile.level.integratedLufs > threshold) {
      add("high_program_loudness", "review",
        { integratedLufs: profile.level.integratedLufs, contextThresholdLufs: threshold, useCase },
        "Program loudness is high for this context threshold. Treat this as a headroom review flag, not a universal mastering target.");
    }
  }
  return findings;
}

export function analyzeWav(bytes: Uint8Array, useCase: UseCase = "general"): AudioProfile {
  const parsed = parseWav(bytes);
  const basic = basicMeasurements(parsed);
  const weighted = kWeight(parsed.samples, parsed.sampleRate);
  const integrated = integratedLoudness(weighted, parsed.sampleRate);
  const shortTerm = blockLoudness(weighted, parsed.sampleRate, 3.0, 0.1);
  const lraShortTerm = blockLoudness(weighted, parsed.sampleRate, 3.0, 0.1, 1.5);
  const spectral = spectrum(parsed);
  const loop = loopMeasurements(parsed);

  const base = {
    measurementVersion: AUDIO_MEASUREMENT_VERSION,
    metadata: {
      format: parsed.format,
      sampleRate: parsed.sampleRate,
      channels: parsed.channels,
      bitsPerSample: parsed.bitsPerSample,
      frames: parsed.frames,
      durationSeconds: round(parsed.frames / parsed.sampleRate, 5),
    },
    level: {
      samplePeakDbfs: round(finite(db20(basic.peak)), 3),
      truePeakDbtp: null,
      integratedLufs: integrated === null ? null : round(integrated, 3),
      rmsDbfs: round(finite(db20(basic.rms)), 3),
      dcOffsetMax: round(basic.dc, 7),
      clippedSamplePct: round(basic.clippedPct, 6),
    },
    dynamics: {
      crestFactorDb: round(finite(db20(basic.peak / Math.max(basic.rms, Math.sqrt(EPS)))), 3),
      loudnessRangeLu: shortTerm.length
        ? (() => {
            const value = loudnessRange(lraShortTerm);
            return value === null ? null : round(value, 3);
          })()
        : null,
      shortTermLufs: shortTerm.length ? {
        min: round(Math.min(...shortTerm), 3),
        p10: round(percentile(shortTerm, 0.1), 3),
        median: round(percentile(shortTerm, 0.5), 3),
        p90: round(percentile(shortTerm, 0.9), 3),
        max: round(Math.max(...shortTerm), 3),
      } : null,
    },
    stereo: {
      available: parsed.channels === 2,
      correlation: basic.correlation === null ? null : round(basic.correlation, 5),
      sideMinusMidDb: basic.sideMinusMidDb === null ? null : round(finite(basic.sideMinusMidDb), 3),
      monoPowerDeltaDb: basic.monoPowerDeltaDb === null ? null : round(finite(basic.monoPowerDeltaDb), 3),
    },
    spectral,
    loop,
  } satisfies Omit<AudioProfile, "findings" | "limitations">;

  return {
    ...base,
    findings: deriveFindings(base, useCase),
    limitations: [
      "Sample peak is measured; inter-sample true peak is not measured in v1.",
      "Spectral bands use bounded Welch-style FFT sampling, so they are diagnostic summaries rather than full-resolution mastering traces.",
      "Stem masking produced from profiles is a spectral-overlap proxy, not a psychoacoustic audibility proof.",
      "Context loudness flags are review thresholds, not universal delivery standards.",
    ],
  };
}

function assertProfile(profile: AudioProfile): void {
  if (!profile || profile.measurementVersion !== AUDIO_MEASUREMENT_VERSION) {
    throw new Error("AUDIO_PROFILE_VERSION_MISMATCH");
  }
  if (!Array.isArray(profile.spectral?.bands)) throw new Error("AUDIO_PROFILE_INVALID");
}

export function compareProfiles(mix: AudioProfile, reference: AudioProfile) {
  assertProfile(mix);
  assertProfile(reference);
  const refBands = new Map(reference.spectral.bands.map((band) => [band.id, band]));
  const bands = mix.spectral.bands
    .map((band) => {
      const ref = refBands.get(band.id);
      if (!ref) return null;
      return {
        id: band.id,
        lowHz: band.lowHz,
        highHz: band.highHz,
        relativeEnergyDeltaDb: round(band.relativeDb - ref.relativeDb, 3),
        sideWidthDeltaDb:
          band.sideMinusMidDb === null || ref.sideMinusMidDb === null
            ? null
            : round(band.sideMinusMidDb - ref.sideMinusMidDb, 3),
      };
    })
    .filter((value) => value !== null);

  const notableBands = bands
    .filter((band) => Math.abs(band.relativeEnergyDeltaDb) >= 2)
    .sort((a, b) => Math.abs(b.relativeEnergyDeltaDb) - Math.abs(a.relativeEnergyDeltaDb));

  return {
    measurementVersion: AUDIO_MEASUREMENT_VERSION,
    method: "level_independent_profile_delta",
    loudnessDeltaLu:
      mix.level.integratedLufs === null || reference.level.integratedLufs === null
        ? null
        : round(mix.level.integratedLufs - reference.level.integratedLufs, 3),
    rmsDeltaDb: round(mix.level.rmsDbfs - reference.level.rmsDbfs, 3),
    crestDeltaDb: round(mix.dynamics.crestFactorDb - reference.dynamics.crestFactorDb, 3),
    stereoCorrelationDelta:
      mix.stereo.correlation === null || reference.stereo.correlation === null
        ? null
        : round(mix.stereo.correlation - reference.stereo.correlation, 4),
    bands,
    notableBands,
    limitation:
      "Reference deltas describe measurable differences only. They do not establish that the reference is correct for the target arrangement, playback system, or game mix.",
  };
}

export function stemMasking(stems: Array<{ name: string; profile: AudioProfile }>) {
  if (stems.length < 2) throw new Error("AUDIO_STEMS_REQUIRE_TWO_OR_MORE");
  if (stems.length > 12) throw new Error("AUDIO_STEM_LIMIT_EXCEEDED");
  for (const stem of stems) assertProfile(stem.profile);

  const pairs = [];
  for (let a = 0; a < stems.length; a += 1) {
    for (let b = a + 1; b < stems.length; b += 1) {
      const left = stems[a], right = stems[b];
      const rightBands = new Map(right.profile.spectral.bands.map((band) => [band.id, band]));
      const overlapBands = left.profile.spectral.bands.flatMap((lb) => {
        const rb = rightBands.get(lb.id);
        if (!rb) return [];
        const leftEstimate = left.profile.level.rmsDbfs + lb.relativeDb;
        const rightEstimate = right.profile.level.rmsDbfs + rb.relativeDb;
        const proximity = Math.abs(leftEstimate - rightEstimate);
        const audibilityFloor = Math.max(leftEstimate, rightEstimate);
        if (proximity > 8 || audibilityFloor < -65 || lb.energyPct < 0.5 || rb.energyPct < 0.5) return [];
        const score = Math.max(0, 8 - proximity) * Math.sqrt(lb.energyPct * rb.energyPct);
        return [{
          id: lb.id,
          lowHz: lb.lowHz,
          highHz: lb.highHz,
          estimatedLevelA: round(leftEstimate, 2),
          estimatedLevelB: round(rightEstimate, 2),
          proximityDb: round(proximity, 2),
          overlapScore: round(score, 2),
        }];
      }).sort((x, y) => y.overlapScore - x.overlapScore);

      const aggregate = overlapBands.slice(0, 4).reduce((sum, band) => sum + band.overlapScore, 0);
      const risk = aggregate >= 100 ? "high" : aggregate >= 35 ? "medium" : "low";
      pairs.push({
        a: left.name,
        b: right.name,
        spectralOverlapRisk: risk,
        aggregateScore: round(aggregate, 2),
        topBands: overlapBands.slice(0, 4),
      });
    }
  }
  pairs.sort((a, b) => b.aggregateScore - a.aggregateScore);
  return {
    measurementVersion: AUDIO_MEASUREMENT_VERSION,
    method: "profile_spectral_overlap_proxy",
    pairs,
    limitation:
      "This ranks spectral overlap from independently measured stems. It cannot prove perceptual masking without synchronized waveform/context analysis.",
  };
}
