import {
  type ArmLease, type ExecutionResult, type RunnerState, type TaskSpec,
  assertArm, safeNotification, type PendingOrder, type TicketState,
} from "./contracts.ts";

export class TicketControlPlane {
  private tasks = new Map<string, TaskSpec>();
  private arms = new Map<string, ArmLease>();
  private results = new Map<string, ExecutionResult>();
  private runner: RunnerState = { runner_ref: "unbound", online: false, state: "OFFLINE", last_sync: new Date(0).toISOString() };
  private revocation = 0;
  private pendingOrder: PendingOrder | undefined;

  status() {
    return { runner_online: this.runner.online, runner_identity: this.runner.runner_ref, runner_version: "0.1.0", prepared_tasks: [...this.tasks.keys()], active_arm: [...this.arms.values()].find(a => !a.used), execution_state: this.runner.state, pending_order_state: this.pendingOrder?.status ?? "NONE", last_sync: this.runner.last_sync };
  }

  getTask(taskId: string) { return this.tasks.get(taskId); }

  probe() {
    return { ok: true as const, read_only: true as const, runner_online: this.runner.online, session_state: "NOT_CONNECTED", challenge: false };
  }

  prepare(task: TaskSpec) {
    if (!task.deadline) throw new Error("DEADLINE_REQUIRED");
    if (task.target_set.candidates.length === 0) throw new Error("EMPTY_TARGET_SET");
    const previous = this.tasks.get(task.task_id);
    const oldArm = this.arms.get(task.task_id);
    if (previous && oldArm && !oldArm.used) { oldArm.used = true; this.revocation += 1; }
    const nextTask = previous ? { ...task, task_revision: previous.task_revision + 1 } : task;
    this.tasks.set(nextTask.task_id, nextTask);
    this.runner = { ...this.runner, state: "PREPARED", task_id: nextTask.task_id };
    return { task_id: nextTask.task_id, task_revision: nextTask.task_revision, target_fingerprint: nextTask.target_set.fingerprint, state: "PREPARED" as const };
  }

  arm(taskId: string, principal: string, runnerRef: string, expiry: string) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("TASK_NOT_FOUND");
    if (this.pendingOrder) throw new Error("EXISTING_PENDING_ORDER");
    const arm: ArmLease = { task_id: task.task_id, task_revision: task.task_revision, target_fingerprint: task.target_set.fingerprint, nonce: crypto.randomUUID(), expiry, revocation_generation: this.revocation, account_ref: task.account_ref, runner_ref: runnerRef, passenger_ref: task.passenger_refs[0] ?? "", query_budget: task.query_budget, submit_budget: task.submit_budget, principal_ref: principal, used: false };
    this.arms.set(taskId, arm);
    this.runner = { runner_ref: runnerRef, online: true, state: "ARMED", task_id: taskId, last_sync: new Date().toISOString() };
    return { ...arm };
  }

  disarm(taskId: string) { const arm = this.arms.get(taskId); if (!arm) return { ok: true as const, state: "DISARMED" as const }; arm.used = true; this.revocation += 1; return { ok: true as const, state: "DISARMED" as const, revocation_generation: this.revocation }; }

  result(taskId: string) { return this.results.get(taskId) ?? { task_id: taskId, state: this.runner.task_id === taskId ? this.runner.state : "OFFLINE", notification: { ok: true, kind: "NONE" as const } }; }

  validateAuthorization(taskId: string, principal: string, runnerRef: string, now = new Date()) {
    const task = this.tasks.get(taskId); const arm = this.arms.get(taskId);
    if (!task || !arm) throw new Error("ARM_NOT_FOUND");
    assertArm(arm, task, principal, runnerRef, now);
    if (arm.revocation_generation !== this.revocation) throw new Error("ARM_REVOKED");
    if (arm.submit_budget < 1) throw new Error("SUBMIT_BUDGET_EXHAUSTED");
    return arm;
  }

  consumeAuthorization(taskId: string, expectedNonce: string) {
    const arm = this.arms.get(taskId);
    if (!arm) throw new Error("ARM_NOT_FOUND");
    if (arm.used) throw new Error("ARM_REPLAY");
    if (arm.nonce !== expectedNonce) throw new Error("ARM_NONCE_MISMATCH");
    arm.used = true;
    return arm;
  }

  authorize(taskId: string, principal: string, runnerRef: string, now = new Date()) {
    const arm = this.validateAuthorization(taskId, principal, runnerRef, now);
    return this.consumeAuthorization(taskId, arm.nonce);
  }

  recordResult(result: ExecutionResult) { this.results.set(result.task_id, result); this.runner = { ...this.runner, state: result.state, last_sync: new Date().toISOString() }; }
  transition(taskId: string, state: TicketState, error_code?: string) { const result: ExecutionResult = { task_id: taskId, state, ...(error_code ? { error_code } : {}), notification: { ok: true, kind: "NONE" } }; this.recordResult(result); return result; }
  lockPending(task: TaskSpec, order: PendingOrder) { this.pendingOrder = order; const result = { task_id: task.task_id, state: "WAITING_FOR_PAYMENT" as TicketState, order_id: order.order_id, notification: safeNotification(task, order) }; this.recordResult(result); return result; }
}