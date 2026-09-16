import test from "node:test";
import assert from "node:assert/strict";
import {
  verificationSupportFor,
  waitForVerificationResolution,
  type AuthChallengeRefresher,
} from "../runner/12306-verification-support.ts";
import type { Mobile12306AuthChallenge } from "../runner/12306-mobile-auth.ts";

function challenge(state: Mobile12306AuthChallenge["state"]): Mobile12306AuthChallenge {
  return {
    challenge_id: "challenge-1",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    state,
    attempts: 0,
  };
}

test("verification registry marks slider and offline identity as OPEN without bypass support", () => {
  assert.deepEqual(verificationSupportFor("SLIDER_REQUIRED"), {
    challenge_state: "SLIDER_REQUIRED",
    issue_status: "OPEN",
    resolution_mode: "HUMAN_HANDOFF_THEN_AUTO_RESUME",
    auto_resume_supported: true,
    bypass_supported: false,
  });

  assert.deepEqual(verificationSupportFor("OFFLINE_IDENTITY_REQUIRED"), {
    challenge_state: "OFFLINE_IDENTITY_REQUIRED",
    issue_status: "OPEN",
    resolution_mode: "EXTERNAL_IDENTITY_RESOLUTION",
    auto_resume_supported: false,
    bypass_supported: false,
  });
});

test("SMS and App confirmation remain supported continuation paths", () => {
  assert.equal(verificationSupportFor("SMS_REQUIRED")?.issue_status, "SUPPORTED");
  assert.equal(verificationSupportFor("SMS_REQUIRED")?.bypass_supported, false);
  assert.equal(verificationSupportFor("APP_CONFIRM_REQUIRED")?.issue_status, "SUPPORTED");
  assert.equal(verificationSupportFor("APP_CONFIRM_REQUIRED")?.auto_resume_supported, true);
});

test("human slider handoff can automatically rejoin the session after it becomes READY", async () => {
  const states: Mobile12306AuthChallenge[] = [
    challenge("SLIDER_REQUIRED"),
    challenge("READY"),
  ];
  let calls = 0;
  const refresher: AuthChallengeRefresher = {
    async refresh() {
      const value = states[Math.min(calls, states.length - 1)]!;
      calls += 1;
      return value;
    },
  };

  const result = await waitForVerificationResolution(refresher, "challenge-1", {
    timeout_ms: 1_000,
    interval_ms: 250,
  });
  assert.equal(result.state, "READY");
  assert.equal(calls, 2);
});

test("offline identity remains an OPEN external blocker and is not polled as if software can solve it", async () => {
  let calls = 0;
  const refresher: AuthChallengeRefresher = {
    async refresh() {
      calls += 1;
      return challenge("OFFLINE_IDENTITY_REQUIRED");
    },
  };

  const result = await waitForVerificationResolution(refresher, "challenge-1", {
    timeout_ms: 1_000,
    interval_ms: 250,
  });
  assert.equal(result.state, "OFFLINE_IDENTITY_REQUIRED");
  assert.equal(calls, 1);
});
