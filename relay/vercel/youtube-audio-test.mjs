import assert from "node:assert/strict";

process.env.HUB_RELAY_TOKEN = "test-relay-secret";
const { default: handler } = await import("./api/youtube-audio.mjs");

const started = Date.now();
const response = await handler.fetch(
  new Request("https://relay.test/api/youtube-audio", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-relay-token": process.env.HUB_RELAY_TOKEN,
    },
    body: JSON.stringify({ videoId: "teKcE8YhLhA" }),
  }),
);

const elapsed = Date.now() - started;
if (!response.ok) {
  throw new Error("youtube audio relay failed: HTTP " + response.status + " " + (await response.text()));
}
const bytes = new Uint8Array(await response.arrayBuffer());
assert.ok(bytes.byteLength > 100000, "audio response is unexpectedly small");
assert.ok(bytes.byteLength <= 32 * 1024 * 1024, "audio response exceeds safety bound");
assert.match(response.headers.get("content-type") ?? "", /^audio\//);
console.log(
  "YOUTUBE_AUDIO_RELAY=PASS bytes=" +
    bytes.byteLength +
    " durationMs=" +
    response.headers.get("x-video-duration-ms") +
    " relayElapsedMs=" +
    response.headers.get("x-relay-elapsed-ms") +
    " testElapsedMs=" +
    elapsed,
);
