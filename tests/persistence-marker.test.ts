import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePersistenceMarker } from "../runner/persistence-marker.ts";

function withTempDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "rail12306-marker-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("persistence marker hash remains stable when the same state directory is reopened", () => {
  withTempDir(dir => {
    const first = ensurePersistenceMarker(dir);
    const second = ensurePersistenceMarker(dir);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(second, first);

    const raw = readFileSync(join(dir, ".rail12306-persistence-marker"), "utf8").trim();
    assert.match(raw, /^[0-9a-f]{64}$/);
    assert.notEqual(raw, first);
  });
});

test("corrupt persistence marker is rejected instead of silently replaced", () => {
  withTempDir(dir => {
    writeFileSync(join(dir, ".rail12306-persistence-marker"), "corrupt-marker", "utf8");
    assert.throws(() => ensurePersistenceMarker(dir), /RAIL12306_PERSISTENCE_MARKER_INVALID/);
  });
});
