import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER_FILENAME = ".rail12306-persistence-marker";
const MARKER_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Creates one non-sensitive random marker on the persistent state volume and
 * returns only its SHA-256 digest. The create-if-absent write is atomic, so a
 * restart/redeploy must observe the same marker when the mounted volume truly
 * persists. The raw marker is never returned or logged.
 */
export function ensurePersistenceMarker(stateDir: string): string {
  const normalizedDir = stateDir.trim();
  if (!normalizedDir) throw new Error("RAIL12306_STATE_DIR_REQUIRED");

  mkdirSync(normalizedDir, { recursive: true });
  const markerPath = join(normalizedDir, MARKER_FILENAME);
  const candidate = randomBytes(32).toString("hex");

  try {
    writeFileSync(markerPath, candidate, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const marker = readFileSync(markerPath, "utf8").trim();
  if (!MARKER_PATTERN.test(marker)) throw new Error("RAIL12306_PERSISTENCE_MARKER_INVALID");
  return createHash("sha256").update(marker, "utf8").digest("hex");
}
