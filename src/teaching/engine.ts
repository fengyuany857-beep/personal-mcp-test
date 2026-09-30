import { getTeachingPreset, type TeachingConcept } from "./presets.ts";

export type ActivityKind =
  | "diagnostic"
  | "guided_practice"
  | "practice"
  | "retrieval"
  | "misconception_repair"
  | "transfer"
  | "feynman";

export type EvidenceKind = "diagnostic" | "practice" | "retrieval" | "transfer" | "explanation";

export type MisconceptionState = {
  tag: string;
  count: number;
  status: "active" | "resolved";
};

export type ConceptState = {
  pKnown: number;
  attempts: number;
  successes: number;
  bestScore: number;
  evidenceKinds: Record<EvidenceKind, number>;
  transferPassed: boolean;
  misconceptions: MisconceptionState[];
  consecutiveFailures: number;
  lastAttemptAt?: string;
  nextReviewAt?: string;
};

export type RubricCriterion = { criterion: string; weight: number };

export type PendingAttempt = {
  id: string;
  conceptId: string;
  kind: ActivityKind;
  task: string;
  rubric: RubricCriterion[];
  createdAt: string;
  responseHash?: string;
  responseChars?: number;
  confidence?: number;
  committedAt?: string;
};

export type HistoryEntry = {
  attemptId: string;
  conceptId: string;
  kind: ActivityKind;
  score: number;
  passed: boolean;
  evaluator: "model" | "human";
  evidenceStrength: "low" | "medium" | "high";
  at: string;
};

export type TeachingState = {
  schemaVersion: 1;
  revision: number;
  presetId: string;
  goal: string;
  startedAt: string;
  updatedAt: string;
  concepts: Record<string, ConceptState>;
  pendingAttempt?: PendingAttempt;
  history: HistoryEntry[];
};

const TOKEN_PREFIX = "LTM1.";
const INITIAL_P_KNOWN = 0.25;
const PREREQ_THRESHOLD = 0.6;
const MASTERY_THRESHOLD = 0.85;
const SLIP = 0.1;
const GUESS = 0.2;
const LEARN = 0.12;
const MAX_HISTORY = 48;

function clamp(v: number, lo = 0.02, hi = 0.98): number {
  return Math.min(hi, Math.max(lo, v));
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

export function encodeTeachingState(state: TeachingState): string {
  return TOKEN_PREFIX + toBase64Url(JSON.stringify(state));
}

export function decodeTeachingState(token: string): TeachingState {
  if (!token.startsWith(TOKEN_PREFIX)) throw new Error("INVALID_TEACHING_STATE_TOKEN");
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(token.slice(TOKEN_PREFIX.length)));
  } catch {
    throw new Error("INVALID_TEACHING_STATE_TOKEN");
  }
  if (!raw || typeof raw !== "object") throw new Error("INVALID_TEACHING_STATE_TOKEN");
  const state = raw as TeachingState;
  if (state.schemaVersion !== 1 || !state.presetId || !state.concepts) {
    throw new Error("UNSUPPORTED_TEACHING_STATE");
  }
  getTeachingPreset(state.presetId);
  return state;
}

function newConceptState(): ConceptState {
  return {
    pKnown: INITIAL_P_KNOWN,
    attempts: 0,
    successes: 0,
    bestScore: 0,
    evidenceKinds: { diagnostic: 0, practice: 0, retrieval: 0, transfer: 0, explanation: 0 },
    transferPassed: false,
    misconceptions: [],
    consecutiveFailures: 0
  };
}

export function createTeachingState(presetId: string, goal: string, now = new Date()): TeachingState {
  const preset = getTeachingPreset(presetId);
  const concepts: Record<string, ConceptState> = {};
  for (const concept of preset.concepts) concepts[concept.id] = newConceptState();
  const stamp = now.toISOString();
  return {
    schemaVersion: 1,
    revision: 1,
    presetId,
    goal: goal.trim() || preset.title,
    startedAt: stamp,
    updatedAt: stamp,
    concepts,
    history: []
  };
}

function prereqsReady(state: TeachingState, concept: TeachingConcept): boolean {
  return concept.prerequisites.every(id => (state.concepts[id]?.pKnown ?? 0) >= PREREQ_THRESHOLD);
}

function due(state: ConceptState, now: Date): boolean {
  return Boolean(state.nextReviewAt && new Date(state.nextReviewAt).getTime() <= now.getTime());
}

function masteryEvidence(state: TeachingState, conceptId: string) {
  const cs = state.concepts[conceptId];
  const evidence = state.history.filter(x => x.conceptId === conceptId);
  const demonstrated =
    evidence.filter(x =>
      ["retrieval", "feynman", "diagnostic"].includes(x.kind) &&
      x.score >= 0.8 &&
      x.evidenceStrength !== "low"
    ).length >= 2;
  const activeMisconceptions = cs.misconceptions.filter(x => x.status === "active").length;
  return {
    estimated: Number(cs.pKnown.toFixed(4)),
    demonstrated,
    transferred: cs.transferPassed,
    masteryReady:
      cs.pKnown >= MASTERY_THRESHOLD &&
      cs.attempts >= 3 &&
      demonstrated &&
      cs.transferPassed &&
      activeMisconceptions === 0
  };
}

export function tutorContractFor(kind: ActivityKind) {
  return {
    sequence: ["elicit", "learner_attempt", "diagnose", "targeted_feedback", "retest", "transfer_when_ready"],
    revealRule:
      "Do not reveal the target answer before a genuine learner attempt unless the learner explicitly asks or a missing prerequisite makes the task impossible.",
    correctionRule:
      "Correct the smallest reasoning error blocking progress. Do not replace the learner's reasoning with a full lecture by default.",
    gradingRule:
      "Grade against a rubric frozen before the response. Agreement after seeing an explanation is not mastery evidence.",
    hintRule:
      kind === "guided_practice" || kind === "misconception_repair"
        ? "Give one narrowing hint at a time. After two genuine failures, make the task smaller."
        : "Withhold hints until the learner makes a first attempt.",
    transferRule: "Use an unseen source or scenario before treating the concept as transferable.",
    oneConceptAtATime: true
  };
}

function activity(state: TeachingState, concept: TeachingConcept, kind: ActivityKind, reason: string) {
  const cs = state.concepts[concept.id];
  return {
    conceptId: concept.id,
    conceptTitle: concept.title,
    kind,
    reason,
    outcome: concept.outcome,
    criteria: concept.criteria,
    exercisePatterns: concept.exercisePatterns,
    currentEstimate: Number(cs.pKnown.toFixed(4)),
    activeMisconceptions: cs.misconceptions.filter(x => x.status === "active"),
    tutorContract: tutorContractFor(kind)
  };
}

export function selectNextActivity(state: TeachingState, now = new Date()) {
  const preset = getTeachingPreset(state.presetId);
  const accessible = preset.concepts.filter(c => prereqsReady(state, c));
  if (!accessible.length) throw new Error("NO_ACCESSIBLE_CONCEPT");

  const misconception = accessible.find(c =>
    state.concepts[c.id].misconceptions.some(m => m.status === "active")
  );
  if (misconception) {
    return activity(state, misconception, "misconception_repair", "Repair the active misconception before adding difficulty.");
  }

  const review = accessible
    .filter(c => due(state.concepts[c.id], now))
    .sort((a, b) =>
      new Date(state.concepts[a.id].nextReviewAt ?? 0).getTime() -
      new Date(state.concepts[b.id].nextReviewAt ?? 0).getTime()
    )[0];
  if (review) return activity(state, review, "retrieval", "This concept is due for retrieval practice.");

  const untested = accessible.find(c => state.concepts[c.id].attempts === 0);
  if (untested) return activity(state, untested, "diagnostic", "No learner evidence exists for this concept yet.");

  const concept = [...accessible].sort((a, b) => state.concepts[a.id].pKnown - state.concepts[b.id].pKnown)[0];
  const cs = state.concepts[concept.id];
  if (cs.pKnown < 0.45 || cs.consecutiveFailures >= 2) {
    return activity(state, concept, "guided_practice", "Knowledge is low or repeated failures call for a smaller scaffolded step.");
  }
  if (cs.pKnown < 0.7) {
    return activity(state, concept, "practice", "The concept is partially known and needs another application.");
  }
  if (cs.pKnown < MASTERY_THRESHOLD) {
    return activity(state, concept, "retrieval", "The concept is ready for answer-without-help retrieval.");
  }
  if (!cs.transferPassed) {
    return activity(state, concept, "transfer", "The estimate is high, but transfer to an unseen case is not yet demonstrated.");
  }
  return activity(state, concept, "feynman", "Explain the concept coherently to expose any hidden gap.");
}

function normalizeRubric(rubric: RubricCriterion[]): RubricCriterion[] {
  const clean = rubric
    .map(x => ({ criterion: x.criterion.trim(), weight: Math.max(0, x.weight) }))
    .filter(x => x.criterion && x.weight > 0);
  const total = clean.reduce((sum, x) => sum + x.weight, 0);
  if (!clean.length || total <= 0) throw new Error("INVALID_RUBRIC");
  return clean.map(x => ({ criterion: x.criterion, weight: x.weight / total }));
}

export function prepareAttempt(
  state: TeachingState,
  conceptId: string,
  kind: ActivityKind,
  task: string,
  rubric: RubricCriterion[],
  now = new Date()
) {
  const preset = getTeachingPreset(state.presetId);
  const concept = preset.concepts.find(c => c.id === conceptId);
  if (!concept) throw new Error("UNKNOWN_CONCEPT");
  if (!prereqsReady(state, concept) && kind !== "diagnostic") throw new Error("PREREQUISITES_NOT_READY");
  if (state.pendingAttempt) throw new Error("ATTEMPT_ALREADY_OPEN");
  const cleanTask = task.trim();
  if (!cleanTask) throw new Error("EMPTY_ATTEMPT_TASK");

  const attempt: PendingAttempt = {
    id: crypto.randomUUID(),
    conceptId,
    kind,
    task: cleanTask,
    rubric: normalizeRubric(rubric),
    createdAt: now.toISOString()
  };
  return {
    attempt,
    state: {
      ...state,
      revision: state.revision + 1,
      updatedAt: now.toISOString(),
      pendingAttempt: attempt
    } satisfies TeachingState
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function commitResponse(
  state: TeachingState,
  attemptId: string,
  response: string,
  confidence?: number,
  now = new Date()
): Promise<TeachingState> {
  const attempt = state.pendingAttempt;
  if (!attempt || attempt.id !== attemptId) throw new Error("ATTEMPT_NOT_OPEN");
  if (attempt.committedAt) throw new Error("RESPONSE_ALREADY_COMMITTED");
  const clean = response.trim();
  if (!clean) throw new Error("EMPTY_LEARNER_RESPONSE");

  return {
    ...state,
    revision: state.revision + 1,
    updatedAt: now.toISOString(),
    pendingAttempt: {
      ...attempt,
      responseHash: await sha256Hex(clean),
      responseChars: clean.length,
      ...(confidence === undefined ? {} : { confidence }),
      committedAt: now.toISOString()
    }
  };
}

function evidenceKind(kind: ActivityKind): EvidenceKind {
  if (kind === "diagnostic") return "diagnostic";
  if (kind === "retrieval") return "retrieval";
  if (kind === "transfer") return "transfer";
  if (kind === "feynman") return "explanation";
  return "practice";
}

function bkt(prior: number, success: boolean, learningOpportunity: boolean): number {
  const p = clamp(prior);
  const posterior = success
    ? (p * (1 - SLIP)) / (p * (1 - SLIP) + (1 - p) * GUESS)
    : (p * SLIP) / (p * SLIP + (1 - p) * (1 - GUESS));
  return clamp(learningOpportunity ? posterior + (1 - posterior) * LEARN : posterior);
}

function nextReview(now: Date, score: number, transferred: boolean): string {
  const days = score < 0.6 ? 1 : score < 0.8 ? 2 : score < 0.9 ? 5 : transferred ? 14 : 10;
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

export function recordEvaluation(
  state: TeachingState,
  attemptId: string,
  score: number,
  misconceptions: string[],
  resolved: string[],
  evaluator: "model" | "human",
  evidenceStrength: "low" | "medium" | "high",
  now = new Date()
) {
  const attempt = state.pendingAttempt;
  if (!attempt || attempt.id !== attemptId) throw new Error("ATTEMPT_NOT_OPEN");
  if (!attempt.committedAt || !attempt.responseHash) throw new Error("RESPONSE_NOT_COMMITTED");

  const boundedScore = Math.max(0, Math.min(1, score));
  const success = boundedScore >= 0.75;
  const cs = state.concepts[attempt.conceptId];
  const learningOpportunity = ["guided_practice", "practice", "misconception_repair"].includes(attempt.kind);
  const nextMisconceptions = cs.misconceptions.map(x => ({ ...x }));

  for (const raw of misconceptions) {
    const tag = raw.trim().slice(0, 120);
    if (!tag) continue;
    const found = nextMisconceptions.find(x => x.tag === tag);
    if (found) {
      found.count += 1;
      found.status = "active";
    } else nextMisconceptions.push({ tag, count: 1, status: "active" });
  }
  for (const raw of resolved) {
    const found = nextMisconceptions.find(x => x.tag === raw.trim());
    if (found) found.status = "resolved";
  }

  const transferPassed =
    cs.transferPassed ||
    (attempt.kind === "transfer" && boundedScore >= 0.8 && evidenceStrength !== "low");
  const kind = evidenceKind(attempt.kind);
  const updated: ConceptState = {
    ...cs,
    pKnown: bkt(cs.pKnown, success, learningOpportunity),
    attempts: cs.attempts + 1,
    successes: cs.successes + (success ? 1 : 0),
    bestScore: Math.max(cs.bestScore, boundedScore),
    evidenceKinds: { ...cs.evidenceKinds, [kind]: cs.evidenceKinds[kind] + 1 },
    transferPassed,
    misconceptions: nextMisconceptions.slice(0, 24),
    consecutiveFailures: success ? 0 : cs.consecutiveFailures + 1,
    lastAttemptAt: now.toISOString(),
    nextReviewAt: nextReview(now, boundedScore, transferPassed)
  };

  const history = [
    ...state.history,
    {
      attemptId,
      conceptId: attempt.conceptId,
      kind: attempt.kind,
      score: boundedScore,
      passed: success,
      evaluator,
      evidenceStrength,
      at: now.toISOString()
    } satisfies HistoryEntry
  ].slice(-MAX_HISTORY);

  const next: TeachingState = {
    ...state,
    revision: state.revision + 1,
    updatedAt: now.toISOString(),
    concepts: { ...state.concepts, [attempt.conceptId]: updated },
    history
  };
  delete next.pendingAttempt;

  return {
    state: next,
    conceptStatus: masteryEvidence(next, attempt.conceptId),
    feedbackContract: {
      passed: success,
      instruction: success
        ? "Confirm the reasoning briefly, then use a variation or transfer task instead of repeating the explanation."
        : "Name the smallest reasoning gap, ask one repair question, and reduce task size after repeated failure.",
      activeMisconceptions: updated.misconceptions.filter(x => x.status === "active")
    }
  };
}

export function teachingSnapshot(state: TeachingState) {
  const preset = getTeachingPreset(state.presetId);
  return {
    revision: state.revision,
    preset: { id: preset.id, title: preset.title },
    goal: state.goal,
    updatedAt: state.updatedAt,
    pendingAttempt: state.pendingAttempt
      ? {
          id: state.pendingAttempt.id,
          conceptId: state.pendingAttempt.conceptId,
          kind: state.pendingAttempt.kind,
          responseCommitted: Boolean(state.pendingAttempt.committedAt)
        }
      : null,
    concepts: preset.concepts.map(c => ({
      id: c.id,
      title: c.title,
      prerequisites: c.prerequisites,
      ...masteryEvidence(state, c.id),
      attempts: state.concepts[c.id].attempts,
      bestScore: state.concepts[c.id].bestScore,
      nextReviewAt: state.concepts[c.id].nextReviewAt ?? null,
      activeMisconceptions: state.concepts[c.id].misconceptions.filter(x => x.status === "active")
    }))
  };
}
