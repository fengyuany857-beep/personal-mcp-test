import assert from "node:assert/strict";
import test from "node:test";
import {
  parseJson3TranscriptForTest,
  parseNoteGptTranscriptForTest,
  parseYoutubeVideoId,
  selectCaptionTrackForTest,
} from "../src/video/tools.ts";

test("YouTube URL parser accepts common video URL shapes and rejects other hosts", () => {
  assert.equal(parseYoutubeVideoId("https://www.youtube.com/watch?v=teKcE8YhLhA"), "teKcE8YhLhA");
  assert.equal(parseYoutubeVideoId("https://youtu.be/teKcE8YhLhA?t=30"), "teKcE8YhLhA");
  assert.equal(parseYoutubeVideoId("https://www.youtube.com/shorts/teKcE8YhLhA"), "teKcE8YhLhA");
  assert.equal(parseYoutubeVideoId("teKcE8YhLhA"), "teKcE8YhLhA");
  assert.equal(parseYoutubeVideoId("https://example.com/watch?v=teKcE8YhLhA"), null);
});

test("caption selection prefers requested language and manual captions", () => {
  const selected = selectCaptionTrackForTest(
    [
      { languageCode: "zh-CN", kind: "asr", baseUrl: "auto" },
      { languageCode: "en", baseUrl: "english" },
      { languageCode: "zh-TW", baseUrl: "manual" },
    ],
    "zh",
  );
  assert.equal(selected?.baseUrl, "manual");
});

test("JSON3 parsing preserves timestamps and joins segment text", () => {
  const segments = parseJson3TranscriptForTest({
    events: [
      { tStartMs: 1000, dDurationMs: 2500, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
      { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: "Next line" }] },
    ],
  });
  assert.deepEqual(segments, [
    { start: 1, duration: 2.5, text: "Hello world" },
    { start: 4, duration: 1, text: "Next line" },
  ]);
});


test("NoteGPT parser selects a usable transcript track and preserves timestamps", () => {
  const parsed = parseNoteGptTranscriptForTest(
    {
      code: 100000,
      data: {
        transcripts: {
          en_auto: {
            default: [
              { start: "00:00:01", end: "00:00:03", text: "First line" },
              { start: "00:00:03", end: "00:00:06", text: "Second line" },
            ],
          },
        },
      },
    },
    "en",
  );

  assert.equal(parsed.language, "en_auto");
  assert.equal(parsed.variant, "default");
  assert.deepEqual(parsed.segments, [
    { start: 1, duration: 2, text: "First line" },
    { start: 3, duration: 3, text: "Second line" },
  ]);
});
