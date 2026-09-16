import { dirname } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Checkpoint, EffectRecord, EffectState, EffectTransition, ExecutionResult, NotificationResult, PendingOrder, RunnerState, TaskSpec, TicketState } from "../src/ticket/contracts.ts";

export class EffectLedger {
  readonly records: EffectRecord[] = [];
  readonly transitions: EffectTransition[] = [];

  start(task_id: string, effect: EffectRecord["effect"]): EffectRecord {
    const record: EffectRecord = { effect_id: crypto.randomUUID(), task_id, effect, semantics: effect === "SUBMIT_ORDER" ? "NON_IDEMPOTENT_UNKNOWN" : "IDEMPOTENT", state: "STARTED", at: new Date().toISOString() };
    this.records.push(record);
    this.transitions.push({ transition_id: crypto.randomUUID(), effect_id: record.effect_id, from_state: "NONE", to_state: "STARTED", observed_at: record.at, reason: "effect_started" });
    return { ...record };
  }

  transition(effect_id: string, to_state: EffectState, reason: string) {
    const record = this.records.find(item => item.effect_id === effect_id);
    if (!record) throw new Error("EFFECT_NOT_FOUND");
    const from_state = record.state;
    record.state = to_state;
    this.transitions.push({ transition_id: crypto.randomUUID(), effect_id, from_state, to_state, observed_at: new Date().toISOString(), reason });
  }

  markUnknown(effect_id: string, reason = "outcome_unknown") { this.transition(effect_id, "UNKNOWN", reason); }
  markReconciling(effect_id: string, reason = "query_real_state") { this.transition(effect_id, "RECONCILING", reason); }
  complete(effect_id: string, reason = "postcondition_verified") { this.transition(effect_id, "COMPLETED", reason); }
  block(effect_id: string, reason = "effect_blocked") { this.transition(effect_id, "BLOCKED", reason); }
}

export interface CheckpointBackend {
  save(checkpoint: Checkpoint): void;
  load(task_id: string): Checkpoint | undefined;
}

export class InMemoryCheckpointBackend implements CheckpointBackend {
  private readonly checkpoints = new Map<string, Checkpoint>();
  save(checkpoint: Checkpoint) { this.checkpoints.set(checkpoint.task_id, { ...checkpoint, effect_ids: [...checkpoint.effect_ids] }); }
  load(task_id: string) { const checkpoint = this.checkpoints.get(task_id); return checkpoint ? { ...checkpoint, effect_ids: [...checkpoint.effect_ids] } : undefined; }
}

export class JsonFileCheckpointBackend implements CheckpointBackend {
  private readonly path: string;
  constructor(path: string) { this.path = path; }

  save(checkpoint: Checkpoint) {
    const state = this.readAll();
    state[checkpoint.task_id] = { ...checkpoint, effect_ids: [...checkpoint.effect_ids] };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
  }

  load(task_id: string) {
    const checkpoint = this.readAll()[task_id];
    return checkpoint ? { ...checkpoint, effect_ids: [...checkpoint.effect_ids] } : undefined;
  }

  private readAll(): Record<string, Checkpoint> {
    try { return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Checkpoint>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }
}

export class CheckpointStore {
  private readonly backend: CheckpointBackend;
  constructor(backend: CheckpointBackend = new InMemoryCheckpointBackend()) { this.backend = backend; }
  save(checkpoint: Checkpoint) { this.backend.save(checkpoint); }
  load(task_id: string) { return this.backend.load(task_id); }
}

export interface PendingOrderReader { readPending(): Promise<PendingOrder[]>; }

export class FakePendingOrderReader implements PendingOrderReader {
  private readonly orders: PendingOrder[];
  constructor(orders: PendingOrder[] = []) { this.orders = orders; }
  async readPending() { return this.orders.map(order => ({ ...order, redacted: true as const })); }
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function verifiedPendingMatch(order: PendingOrder, task: TaskSpec): boolean {
  if (order.status !== "WAITING_FOR_PAYMENT") return false;
  if (order.task_id) return order.task_id === task.task_id;

  if (!order.travel_date || !order.train_code || !order.origin || !order.destination ||
      !order.passenger_refs || !order.seat_classes || typeof order.quantity !== "number") return false;
  if (order.travel_date !== task.travel_date || order.origin !== task.origin || order.destination !== task.destination) return false;
  if (!sameStringSet(order.passenger_refs, task.passenger_refs)) return false;

  const candidate = task.target_set.candidates.find(item => item.train_code === order.train_code && item.quantity === order.quantity);
  if (!candidate) return false;
  return order.seat_classes.every(seat => candidate.seat_classes.includes(seat));
}

export class OutcomeReconciler {
  private readonly reader: PendingOrderReader;
  constructor(reader: PendingOrderReader) { this.reader = reader; }
  async reconcile(task: TaskSpec): Promise<"ORDER_LOCKED" | "NO_EFFECT_VERIFIED" | "BLOCKED"> {
    const orders = await this.reader.readPending();
    if (orders.some(order => verifiedPendingMatch(order, task))) return "ORDER_LOCKED";
    if (orders.length === 0) return "NO_EFFECT_VERIFIED";
    // queryMyOrderNoComplete includes non-payment in-progress orders. Any
    // unmatched/UNKNOWN row is ambiguity, never proof that the submit had no effect.
    return "BLOCKED";
  }
}

export class AccountLeaseManager {
  private readonly held = new Set<string>();
  acquire(accountRef: string) { const key = `12306-account:${accountRef}`; if (this.held.has(key)) throw new Error("BLOCKED_RESOURCE_BUSY"); this.held.add(key); return key; }
  release(key: string) { this.held.delete(key); }
  isHeld(accountRef: string) { return this.held.has(`12306-account:${accountRef}`); }
}

export class NotificationOutbox {
  readonly sent: NotificationResult[] = [];
  async enqueue(result: NotificationResult) { this.sent.push({ ...result }); return result; }
}

export class RunnerSupervisor {
  private state: RunnerState;
  constructor(runner_ref: string) { this.state = { runner_ref, online: false, state: "OFFLINE", last_sync: new Date(0).toISOString() }; }
  start(): RunnerState { this.state = { ...this.state, online: true, state: "READY", last_sync: new Date().toISOString() }; return this.state; }
  resume(checkpoint?: Checkpoint): RunnerState { this.state = { ...this.state, online: true, state: checkpoint?.state ?? "READY", task_id: checkpoint?.task_id, last_sync: new Date().toISOString() }; return this.state; }
  stop(): RunnerState { this.state = { ...this.state, online: false, state: "OFFLINE", last_sync: new Date().toISOString() }; return this.state; }
  snapshot() { return { ...this.state }; }
}

export function checkpointFor(task: TaskSpec, state: TicketState, effect_ids: string[], candidate_id?: string, order_id?: string): Checkpoint {
  return { task_id: task.task_id, task_revision: task.task_revision, state, effect_ids: [...effect_ids], ...(candidate_id ? { candidate_id } : {}), ...(order_id ? { order_id } : {}), saved_at: new Date().toISOString() };
}

export type SafeExecutionResult = ExecutionResult & { payment_capability: "NOT_AVAILABLE" };
