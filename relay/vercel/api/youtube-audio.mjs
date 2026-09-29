import { createHash, timingSafeEqual } from "node:crypto";
import { JSDOM } from "jsdom";
import { BotGuardClient } from "bgutils-js/botguard";
import { WebPoMinter } from "bgutils-js/webpo";
import { buildURL, getHeaders, parseLooseJSON, USER_AGENT } from "bgutils-js/utils";
import { Innertube } from "youtubei.js";

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_VIDEO_MINUTES = 30;
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";

let domReady = false;
let minterCache = null;

function sameSecret(actual, expected) {
  if (!actual || !expected) return false;
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function json(status, body) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function ensureDom() {
  if (domReady) return;
  const dom = new JSDOM(
    '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
    {
      url: "https://www.youtube.com/",
      referrer: "https://www.youtube.com/",
      resources: "usable",
      pretendToBeVisual: true,
      userAgent: USER_AGENT,
    },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  });
  if (!Reflect.has(globalThis, "navigator")) {
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });
  }
  domReady = true;
}

async function fetchHomepageChallenge() {
  const response = await fetch("https://www.youtube.com/", {
    headers: {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.7",
      "user-agent": USER_AGENT,
    },
  });
  if (!response.ok) throw new Error("youtube homepage HTTP " + response.status);
  const html = await response.text();

  const ytcfgMatch = html.match(/ytcfg\.set\(({.+?})\);/s);
  if (ytcfgMatch) {
    try {
      const ytObj = { config_: JSON.parse(ytcfgMatch[1]) };
      globalThis.yt = ytObj;
      if (globalThis.window) globalThis.window.yt = ytObj;
    } catch {}
  }

  const attMatch = html.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
  if (!attMatch) throw new Error("youtube homepage has no ytAtN challenge");
  const attData = parseLooseJSON(attMatch[1]);
  const challenge = attData?.R?.bgChallenge;
  if (!challenge?.program || !challenge?.interpreterUrl) {
    throw new Error("youtube ytAtN challenge missing BotGuard fields");
  }
  return challenge;
}

async function createMinter() {
  ensureDom();
  const challenge = await fetchHomepageChallenge();
  const interpreterUrl =
    challenge.interpreterUrl.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  if (!interpreterUrl) throw new Error("BotGuard interpreter URL missing");

  const jsResponse = await fetch("https:" + interpreterUrl, {
    headers: { "user-agent": USER_AGENT },
  });
  if (!jsResponse.ok) throw new Error("BotGuard interpreter HTTP " + jsResponse.status);
  const interpreterJavascript = await jsResponse.text();
  new Function(interpreterJavascript)();

  const bgClient = await BotGuardClient.create({
    program: challenge.program,
    globalName: challenge.globalName,
    globalObject: globalThis,
  });
  const webPoSignalOutput = [];
  const botguardResponse = await bgClient.snapshot({ webPoSignalOutput });

  const integrityResponse = await fetch(buildURL("GenerateIT"), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  if (!integrityResponse.ok) {
    throw new Error("GenerateIT HTTP " + integrityResponse.status);
  }
  const [
    integrityToken,
    estimatedTtlSecs,
    mintRefreshThreshold,
    websafeFallbackToken,
  ] = await integrityResponse.json();
  if (!integrityToken) throw new Error("GenerateIT returned empty token");

  return {
    expiresAt: Date.now() + Math.max(60, Number(estimatedTtlSecs || 300)) * 1000,
    minter: await WebPoMinter.create(
      {
        integrityToken,
        estimatedTtlSecs,
        mintRefreshThreshold,
        websafeFallbackToken,
      },
      webPoSignalOutput,
    ),
  };
}

async function mintPoToken(videoId) {
  if (!minterCache || Date.now() >= minterCache.expiresAt - 30_000) {
    minterCache = await createMinter();
  }
  return minterCache.minter.mintAsWebsafeString(videoId);
}

function isVideoId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value);
}

async function fetchAudio(videoId, poToken) {
  const yt = await Innertube.create({
    enable_session_cache: false,
    generate_session_locally: true,
    retrieve_player: true,
    po_token: poToken,
  });

  const info = await yt.getBasicInfo(videoId, {
    client: "MWEB",
    po_token: poToken,
  });
  const streaming = info.streaming_data;
  if (!streaming) throw new Error("MWEB returned no streaming data");

  const formats = [
    ...(streaming.adaptive_formats ?? []),
    ...(streaming.formats ?? []),
  ]
    .filter((format) => {
      const mime = String(format.mime_type ?? "");
      return (
        format.has_audio &&
        mime.startsWith("audio/") &&
        !format.drm_families?.length &&
        Boolean(format.url || format.signature_cipher || format.cipher)
      );
    })
    .sort((a, b) => {
      const sizeA = Number(a.content_length ?? Number.MAX_SAFE_INTEGER);
      const sizeB = Number(b.content_length ?? Number.MAX_SAFE_INTEGER);
      if (sizeA !== sizeB) return sizeA - sizeB;
      return Number(a.bitrate ?? 0) - Number(b.bitrate ?? 0);
    });

  if (!formats.length) throw new Error("MWEB returned no usable audio formats");

  let lastError = "";
  for (const format of formats) {
    const durationMs = Number(format.approx_duration_ms ?? 0);
    if (durationMs > MAX_VIDEO_MINUTES * 60_000) {
      throw new RangeError("video exceeds " + MAX_VIDEO_MINUTES + " minute limit");
    }
    const declared = Number(format.content_length ?? 0);
    if (declared > MAX_AUDIO_BYTES) continue;

    try {
      let audioUrl = format.url ?? "";
      if (!audioUrl) audioUrl = await format.decipher(yt.session.player);
      if (!audioUrl) continue;

      const url = new URL(audioUrl);
      if (!url.searchParams.has("pot")) url.searchParams.set("pot", poToken);

      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
      });
      if (!response.ok) {
        lastError = "audio HTTP " + response.status;
        continue;
      }
      const headerBytes = Number(response.headers.get("content-length") ?? 0);
      if (headerBytes > MAX_AUDIO_BYTES) continue;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_AUDIO_BYTES) continue;

      return {
        buffer,
        durationMs,
        mimeType: String(format.mime_type ?? "audio/webm").split(";")[0],
        bytes: buffer.byteLength,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error("no fetchable audio format" + (lastError ? ": " + lastError : ""));
}

export default {
  async fetch(request) {
    const relaySecret = process.env.HUB_RELAY_TOKEN;
    if (!relaySecret) return json(503, { ok: false, code: "RELAY_NOT_CONFIGURED" });
    if (!sameSecret(request.headers.get("x-hub-relay-token"), relaySecret)) {
      return json(401, { ok: false, code: "RELAY_UNAUTHORIZED" });
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { ok: false, code: "INVALID_JSON" });
    }
    const videoId = body?.videoId;
    if (!isVideoId(videoId)) {
      return json(400, { ok: false, code: "INVALID_VIDEO_ID" });
    }

    try {
      const started = Date.now();
      const poToken = await mintPoToken(videoId);
      if (!poToken) throw new Error("empty PO token");
      const audio = await fetchAudio(videoId, poToken);
      return new Response(audio.buffer, {
        status: 200,
        headers: {
          "content-type": audio.mimeType,
          "content-length": String(audio.bytes),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-video-duration-ms": String(audio.durationMs || 0),
          "x-youtube-audio-provider": "mweb+bgutils-webpo",
          "x-relay-elapsed-ms": String(Date.now() - started),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      return json(error instanceof RangeError ? 413 : 502, {
        ok: false,
        code: error instanceof RangeError ? "VIDEO_LIMIT_EXCEEDED" : "YOUTUBE_AUDIO_FAILED",
        message,
      });
    }
  },
};
