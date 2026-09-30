import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AUDIO_MEASUREMENT_VERSION, analyzeWav, compareProfiles, stemMasking, type AudioProfile, type UseCase } from "./analyzer.ts";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".home.arpa"] as const;
const openAIFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1).max(512),
  mime_type: z.string().max(200).optional(),
  file_name: z.string().max(512).optional(),
}).strict();
type OpenAIFileInput = z.infer<typeof openAIFileSchema>;

function jsonResult(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}
function fail(error: unknown) {
  return jsonResult({ ok: false, code: error instanceof Error ? error.message : String(error) }, true);
}
function ipv4IsPrivate(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
export function validateHostFileUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("AUDIO_FILE_HTTPS_REQUIRED");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new Error("AUDIO_FILE_HOST_REQUIRED");
  if (host === "localhost" || host === "metadata.google.internal" || host.includes(":") ||
      ipv4IsPrivate(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error("AUDIO_FILE_PRIVATE_TARGET_BLOCKED");
  }
  if (url.username || url.password) throw new Error("AUDIO_FILE_CREDENTIALS_BLOCKED");
  return url;
}
async function fetchHostFile(file: OpenAIFileInput): Promise<Uint8Array> {
  const url = validateHostFileUrl(file.download_url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "audio/wav,audio/x-wav,audio/*;q=0.8,application/octet-stream;q=0.5" },
    });
    if (response.status >= 300 && response.status < 400) throw new Error("AUDIO_FILE_REDIRECT_BLOCKED");
    if (!response.ok) throw new Error(`AUDIO_FILE_FETCH_HTTP_${response.status}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_AUDIO_BYTES) throw new Error("AUDIO_FILE_TOO_LARGE");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_AUDIO_BYTES) throw new Error("AUDIO_FILE_TOO_LARGE");
    return new Uint8Array(buffer);
  } finally {
    clearTimeout(timer);
  }
}
function asProfile(value: unknown): AudioProfile {
  if (!value || typeof value !== "object") throw new Error("AUDIO_PROFILE_INVALID");
  const profile = value as AudioProfile;
  if (profile.measurementVersion !== AUDIO_MEASUREMENT_VERSION) throw new Error("AUDIO_PROFILE_VERSION_MISMATCH");
  if (!profile.level || !profile.dynamics || !profile.stereo || !Array.isArray(profile.spectral?.bands)) {
    throw new Error("AUDIO_PROFILE_INVALID");
  }
  return profile;
}

export function registerAudioTools(server: McpServer): void {
  server.registerTool(
    "audio.analyze_wav",
    {
      title: "Analyze WAV mix",
      description:
        "Read-only deterministic mono/stereo WAV mix analysis for a ChatGPT-authorized file. Measures K-weighted gated integrated loudness, RMS/sample peak/crest, short-term loudness and LRA-style range, stereo correlation and mono loss, bounded spectral-band energy and M/S width, clipping/DC, and loop-seam evidence. V1 deliberately does not claim inter-sample true peak.",
      inputSchema: z.object({
        audio_file: openAIFileSchema,
        use_case: z.enum(["general", "game_bgm", "showreel"]).default("general"),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
      _meta: { "openai/fileParams": ["audio_file"] },
    },
    async ({ audio_file, use_case }) => {
      try {
        const bytes = await fetchHostFile(audio_file);
        const profile = analyzeWav(bytes, use_case as UseCase);
        return jsonResult({
          ok: true,
          source: {
            kind: "chatgpt_file",
            file_id: audio_file.file_id,
            file_name: audio_file.file_name ?? null,
            mime_type: audio_file.mime_type ?? null,
            byteLength: bytes.byteLength,
          },
          profile,
          evidence_state: "MEASURED_FROM_AUDIO",
        });
      } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    "audio.compare_reference",
    {
      title: "Compare mix to reference",
      description:
        "Compare two profiles returned by audio.analyze_wav. Reports loudness, dynamics, stereo, and level-independent spectral-band deltas. A reference is comparison evidence, not an automatic target.",
      inputSchema: z.object({ mix_profile: z.unknown(), reference_profile: z.unknown() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ mix_profile, reference_profile }) => {
      try {
        return jsonResult({
          ok: true,
          comparison: compareProfiles(asProfile(mix_profile), asProfile(reference_profile)),
          evidence_state: "DERIVED_FROM_MEASURED_PROFILES",
        });
      } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    "audio.stem_masking",
    {
      title: "Rank stem masking risk",
      description:
        "Rank spectral-overlap risk between independently analyzed stems. Accepts compact profiles from audio.analyze_wav, so stems do not need to be uploaded in one giant request. This is an overlap proxy, not proof of perceptual masking.",
      inputSchema: z.object({
        stems: z.array(z.object({ name: z.string().min(1).max(120), profile: z.unknown() })).min(2).max(12),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ stems }) => {
      try {
        return jsonResult({
          ok: true,
          result: stemMasking(stems.map((stem) => ({ name: stem.name, profile: asProfile(stem.profile) }))),
          evidence_state: "SPECTRAL_OVERLAP_PROXY",
        });
      } catch (error) { return fail(error); }
    },
  );
}
