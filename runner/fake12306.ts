import { type EffectRecord, type ExecutionResult, type PendingOrder, type TaskSpec } from "../src/ticket/contracts.ts";
import { TicketControlPlane } from "../src/ticket/control.ts";

export type FakeFault = "network_timeout" | "response_loss" | "session_expired" | "challenge" | "notification_failure";

export class Fake12306Adapter {
  readonly effects: EffectRecord[] = [];
  private pending: PendingOrder | undefined;
  private readonly control: TicketControlPlane;
  constructor(control: TicketControlPlane) { this.control = control; }

  run(task: TaskSpec, principal: string, runnerRef: string, faults: FakeFault[] = []): ExecutionResult {
    if (this.pending) throw new Error("EXISTING_PENDING_ORDER");
    if (faults.includes("session_expired")) return this.fail(task.task_id, "AUTH_REQUIRED");
    if (faults.includes("challenge")) return this.fail(task.task_id, "HUMAN_ACTION_REQUIRED");
    this.control.authorize(task.task_id, principal, runnerRef);
    const candidate = [...task.target_set.candidates].sort((a, b) => a.priority - b.priority)[0];
    if (!candidate) return this.fail(task.task_id, "NO_CANDIDATE");
    const unknown = faults.includes("response_loss") || faults.includes("network_timeout");
    this.effects.push({ effect_id: crypto.randomUUID(), task_id: task.task_id, effect: "SUBMIT_ORDER", semantics: "NON_IDEMPOTENT_UNKNOWN", state: unknown ? "UNKNOWN" : "STARTED", at: new Date().toISOString() });
    if (unknown && faults.includes("network_timeout")) return this.fail(task.task_id, "OUTCOME_UNKNOWN");
    this.pending = { order_id: `fake-${crypto.randomUUID()}`, task_id: task.task_id, status: "WAITING_FOR_PAYMENT", travel_date: task.travel_date, train_code: candidate.train_code, redacted: true };
    const result = this.control.lockPending(task, this.pending);
    if (faults.includes("notification_failure")) result.notification = { ok: false, kind: "PENDING_ORDER", error: "NOTIFICATION_FAILED" };
    return result;
  }

  private fail(task_id: string, error_code: string): ExecutionResult {
    const result = { task_id, state: error_code as ExecutionResult["state"], error_code, notification: { ok: true, kind: "NONE" as const } };
    this.control.recordResult(result);
    return result;
  }
}
