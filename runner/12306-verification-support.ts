import type {
  Mobile12306AuthChallenge,
  Mobile12306AuthChallengeState,
} from "./12306-mobile-auth.ts";

export type VerificationIssueStatus = "SUPPORTED" | "OPEN";
export type VerificationResolutionMode =
  | "AUTOMATED_CONTINUATION"
  | "HUMAN_CONFIRM_THEN_AUTO_RESUME"
  | "HUMAN_HANDOFF_THEN_AUTO_RESUME"
  | "EXTERNAL_IDENTITY_RESOLUTION";

export type VerificationSupport = {
  challenge_state: Mobile12306AuthChallengeState;
  issue_status: VerificationIssueStatus;
  resolution_mode: VerificationResolutionMode;
  auto_resume_supported: boolean;
  bypass_supported: false;
};

const SUPPORT: Partial<Record<Mobile12306AuthChallengeState, VerificationSupport>> = {
  SMS_REQUIRED: {
    challenge_state: "SMS_REQUIRED",
    issue_status: "SUPPORTED",
    resolution_mode: "AUTOMATED_CONTINUATION",
    auto_resume_supported: true,
    bypass_supported: false,
  },
  APP_CONFIRM_REQUIRED: {
    challenge_state: "APP_CONFIRM_REQUIRED",
    issue_status: "SUPPORTED",
    resolution_mode: "HUMAN_CONFIRM_THEN_AUTO_RESUME",
    auto_resume_supported: true,
    bypass_supported: false,
  },
  SLIDER_REQUIRED: {
    challenge_state: "SLIDER_REQUIRED",
    issue_status: "OPEN",
    resolution_mode: "HUMAN_HANDOFF_THEN_AUTO_RESUME",
    auto_resume_supported: true,
    bypass_supported: false,
  },
  OFFLINE_IDENTITY_REQUIRED: {
    challenge_state: "OFFLINE_IDENTITY_REQUIRED",
    issue_status: "OPEN",
    resolution_mode: "EXTERNAL_IDENTITY_RESOLUTION",
    auto_resume_supported: false,
    bypass_supported: false,
  },
};

export function verificationSupportFor(
  state: Mobile12306AuthChallengeState,
): VerificationSupport | undefined {
  return SUPPORT[state];
}

export interface AuthChallengeRefresher {
  refresh(challengeId: string): Promise<Mobile12306AuthChallenge>;
}

export type WaitForVerificationOptions = {
  timeout_ms?: number;
  interval_ms?: number;
  signal?: AbortSignal;
};

const POLLABLE = new Set<Mobile12306AuthChallengeState>([
  "APP_CONFIRM_REQUIRED",
  "SLIDER_REQUIRED",
  "HUMAN_ACTION_REQUIRED",
]);

/**
 * Observes an already-started human verification flow and resumes once the
 * existing authenticated session becomes READY. It never solves, bypasses, or
 * submits a verification challenge itself.
 */
export async function waitForVerificationResolution(
  refresher: AuthChallengeRefresher,
  challengeId: string,
  options: WaitForVerificationOptions = {},
): Promise<Mobile12306AuthChallenge> {
  const timeoutMs = Math.min(Math.max(options.timeout_ms ?? 120_000, 1_000), 10 * 60_000);
  const intervalMs = Math.min(Math.max(options.interval_ms ?? 2_000, 250), 10_000);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (options.signal?.aborted) throw new Error("RAIL12306_VERIFICATION_WAIT_ABORTED");

    const current = await refresher.refresh(challengeId);
    if (current.state === "READY") return current;
    if (current.state === "OFFLINE_IDENTITY_REQUIRED") return current;
    if (current.state === "EXPIRED" || current.state === "LOCKED") return current;
    if (!POLLABLE.has(current.state)) return current;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return current;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}
