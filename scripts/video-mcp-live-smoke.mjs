import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = process.env.MCP_ENDPOINT;
const videoUrl = process.env.VIDEO_URL ?? "https://www.youtube.com/watch?v=teKcE8YhLhA";
if (!endpoint) throw new Error("MCP_ENDPOINT is required");

const { Innertube } = await import("youtubei.js");
const ytProbe = await Innertube.create({ enable_session_cache: false, generate_session_locally: true, retrieve_player: true });
for (const probeClient of ["VISIONOS", "ANDROID_VR", "TV", "WEB_EMBEDDED"]) {
  const started = Date.now();
  try {
    const info = await ytProbe.getBasicInfo("teKcE8YhLhA", { client: probeClient });
    const formats = [
      ...(info.streaming_data?.adaptive_formats ?? []),
      ...(info.streaming_data?.formats ?? []),
    ].filter((format) => format.has_audio);
    console.log("YT_PROBE=" + probeClient + " ms=" + (Date.now() - started) + " formats=" + formats.length + " direct=" + formats.filter((f) => Boolean(f.url)).length + " cipher=" + formats.filter((f) => Boolean(f.signature_cipher || f.cipher)).length);
  } catch (error) {
    console.log("YT_PROBE=" + probeClient + " ms=" + (Date.now() - started) + " ERROR=" + String(error).slice(0,240));
  }
}

const client = new Client(
  { name: "video-transcript-smoke", version: "1.1.0" },
  { versionNegotiation: { mode: "legacy" }, listMaxPages: 8 },
);
const transport = new StreamableHTTPClientTransport(new URL(endpoint));

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === "video.youtube_transcript");
  assert.ok(tool, "video.youtube_transcript is missing from tools/list");

  const result = await client.callTool(
    {
      name: "video.youtube_transcript",
      arguments: {
        url: videoUrl,
        includeTimestamps: false,
        maxCharacters: 20000,
        allowAsr: true,
        maxAsrMinutes: 30,
      },
    },
    undefined,
    { toolDefinition: tool },
  );

  if (result?.isError) {
    throw new Error("video.youtube_transcript failed: " + JSON.stringify(result));
  }
  const structured = result?.structuredContent;
  assert.equal(structured?.ok, true);
  assert.ok(typeof structured?.text === "string" && structured.text.length > 100);
  console.log(
    "VIDEO_TRANSCRIPT=PASS provider=" +
      structured.provider +
      " language=" +
      structured.language +
      " chars=" +
      structured.text.length,
  );
  console.log("VIDEO_TRANSCRIPT_SAMPLE=" + structured.text.slice(0, 500).replace(/\s+/g, " "));
} finally {
  try {
    await client.close();
  } catch {}
}
