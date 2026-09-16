export const TICKET_CAPABILITY_NOT_AVAILABLE = "CAPABILITY_NOT_AVAILABLE" as const;

export type TicketState =
  | "OFFLINE" | "AUTH_REQUIRED" | "READY" | "PROBED" | "PREPARED" | "ARMED"
  | "WAITING_FOR_SALE" | "SEARCHING" | "COMMIT_CANDIDATE_SELECTED" | "SUBMITTING"
  | "OUTCOME_UNKNOWN" | "RECONCILING" | "QUEUED" | "ORDER_ID_OBSERVED"
  | "ORDER_LOCKED" | "WAITING_FOR_PAYMENT" | "HUMAN_ACTION_REQUIRED" | "BLOCKED";

export type Candidate = {
  candidate_id: string;
  train_code: string;
  seat_classes: string[];
  quantity: number;
  priority: number;
  max_price_optional?: number;
};

export type BoundedTargetSet = {
  target_set_id: string;
  candidates: Candidate[];
  fingerprint: string;
};

export type TaskSpec = {
  task_id: string;
  task_revision: number;
  travel_date: string;
  origin: string;
  destination: string;
  passenger_refs: string[];
  target_set: BoundedTargetSet;
  account_ref: string;
  runner_ref: string;
  query_budget: number;
  time_budget_ms: number;
  submit_budget: number;
  deadline?: string;
};

export type ArmLease = {
  task_id: string;
  task_revision: number;
  target_fingerprint: string;
  nonce: string;
  expiry: string;
  revocation_generation: number;
  account_ref: string;
  runner_ref: string;
  passenger_ref: string;
  query_budget: number;
  submit_budget: number;
  principal_ref: string;
  used: boolean;
};

export type EffectState = "STARTED" | "COMPLETED" | "UNKNOWN" | "BLOCKED" | "RECONCILING";

export type EffectRecord = {
  effect_id: string;
  task_id: string;
  effect: "QUERY" | "SUBMIT_ORDER" | "READ_PENDING_ORDER" | "NOTIFICATION";
  semantics: "IDEMPOTENT" | "NON_IDEMPOTENT_UNKNOWN";
  state: EffectState;
  at: string;
};

export type EffectTransition = {
  transition_id: string;
  effect_id: string;
  from_state: EffectState | "NONE";
  to_state: EffectState;
  observed_at: string;
  reason: string;
};

export type Checkpoint = {
  task_id: string;
  task_revision: number;
  state: TicketState;
  candidate_id?: string;
  order_id?: string;
  effect_ids: string[];
  saved_at: string;
};

export type PendingOrder = {
  order_id: string;
  task_id?: string;
  status: "WAITING_FOR_PAYMENT" | "UNKNOWN";
  travel_date?: string;
  train_code?: string;
  origin?: string;
  destination?: string;
  passenger_refs?: string[];
  seat_classes?: string[];
  quantity?: number;
  amount?: number;
  payment_deadline?: string;
  redacted: true;
};

export type NotificationResult = {
  ok: boolean;
  kind: "PENDING_ORDER" | "NONE";
  error?: string;
};

export type RunnerState = {
  runner_ref: string;
  online: boolean;
  state: TicketState;
  task_id?: string;
  last_sync: string;
};

export type ExecutionResult = {
  task_id: string;
  state: TicketState;
  order_id?: string;
  error_code?: string;
  notification: NotificationResult;
};

export function targetFingerprint(target: Omit<BoundedTargetSet, "fingerprint">): string {
  return Array.from(new TextEncoder().encode(JSON.stringify(target)))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function makeTargetSet(input: Omit<BoundedTargetSet, "fingerprint">): BoundedTargetSet {
  return { ...input, fingerprint: targetFingerprint(input) };
}

export function newTaskId(): string { return `ticket-${crypto.randomUUID()}`; }

export function assertArm(arm: ArmLease, task: TaskSpec, principal: string, runner: string, now = new Date()): void {
  if (arm.used) throw new Error("ARM_REPLAY");
  if (arm.task_id !== task.task_id || arm.task_revision !== task.task_revision) throw new Error("STALE_ARM");
  if (arm.target_fingerprint !== task.target_set.fingerprint) throw new Error("TARGET_CHANGED");
  if (arm.account_ref !== task.account_ref) throw new Error("WRONG_ACCOUNT");
  if (arm.runner_ref !== runner) throw new Error("WRONG_RUNNER");
  if (arm.principal_ref !== principal) throw new Error("WRONG_PRINCIPAL");
  if (Date.parse(arm.expiry) <= now.getTime()) throw new Error("ARM_EXPIRED");
}

export function safeNotification(task: TaskSpec, order?: PendingOrder): NotificationResult {
  if (!order) return { ok: true, kind: "NONE" };
  void task;
  return { ok: true, kind: "PENDING_ORDER" };
}
