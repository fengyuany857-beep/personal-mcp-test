import type { Checkpoint, EffectRecord, ExecutionResult, NotificationResult, PendingOrder, RunnerState, TaskSpec, TicketState } from "../src/ticket/contracts.ts";

export class EffectLedger {
  readonly records: EffectRecord[] = [];
  start(task_id: string, effect: EffectRecord["effect"]): EffectRecord {
    const record: EffectRecord = { effect_id: crypto.randomUUID(), task_id, effect, semantics: effect === "SUBMIT_ORDER" ? "NON_IDEMPOTENT_UNKNOWN" : "IDEMPOTENT", state: "STARTED", at: new Date().toISOString() };
    this.records.push(record); return record;
  }
  markUnknown(effect_id: string) { const record = this.records.find(item => item.effect_id === effect_id); if (record) record.state = "UNKNOWN"; }
  complete(effect_id: string) { const record = this.records.find(item => item.effect_id === effect_id); if (record) record.state = "COMPLETED"; }
}

export class CheckpointStore {
  private readonly checkpoints = new Map<string, Checkpoint>();
  save(checkpoint: Checkpoint) { this.checkpoints.set(checkpoint.task_id, { ...checkpoint }); }
  load(task_id: string) { return this.checkpoints.get(task_id); }
}

export interface PendingOrderReader { readPending(): Promise<PendingOrder[]>; }

export class FakePendingOrderReader implements PendingOrderReader {
  private readonly orders: PendingOrder[];
  constructor(orders: PendingOrder[] = []) { this.orders = orders; }
  async readPending() { return this.orders.map(order => ({ ...order, redacted: true as const })); }
}

export class OutcomeReconciler {
  private readonly reader: PendingOrderReader;
  constructor(reader: PendingOrderReader) { this.reader = reader; }
  async reconcile(task: TaskSpec): Promise<"ORDER_LOCKED" | "NO_EFFECT_VERIFIED" | "BLOCKED"> {
    const orders = await this.reader.readPending();
    const match = orders.find(order => order.task_id === task.task_id || (order.travel_date === task.travel_date && order.train_code === task.target_set.candidates[0]?.train_code));
    if (match) return "ORDER_LOCKED";
    return orders.length === 0 ? "NO_EFFECT_VERIFIED" : "BLOCKED";
  }
}

export class NotificationOutbox {
  readonly sent: NotificationResult[] = [];
  async enqueue(result: NotificationResult) { this.sent.push({ ...result }); return result; }
}

export class RunnerSupervisor {
  private state: RunnerState;
  constructor(runner_ref: string) { this.state = { runner_ref, online: false, state: "OFFLINE", last_sync: new Date(0).toISOString() }; }
  start(): RunnerState { this.state = { ...this.state, online: true, state: "READY", last_sync: new Date().toISOString() }; return this.state; }
  stop(): RunnerState { this.state = { ...this.state, online: false, state: "OFFLINE", last_sync: new Date().toISOString() }; return this.state; }
  snapshot() { return { ...this.state }; }
}

export function checkpointFor(task: TaskSpec, state: TicketState, effect_ids: string[], candidate_id?: string, order_id?: string): Checkpoint {
  return { task_id: task.task_id, task_revision: task.task_revision, state, effect_ids: [...effect_ids], ...(candidate_id ? { candidate_id } : {}), ...(order_id ? { order_id } : {}), saved_at: new Date().toISOString() };
}

export type SafeExecutionResult = ExecutionResult & { payment_capability: "NOT_AVAILABLE" };
