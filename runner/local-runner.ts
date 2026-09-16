import { assertArm, type ArmLease, type Candidate, type Checkpoint, type EffectRecord, type TaskSpec, type TicketState } from "../src/ticket/contracts.ts";
import { AccountLeaseManager, CheckpointStore, EffectLedger, NotificationOutbox, type AccountLeaseProvider, type EffectLedgerProvider, type PendingOrderReader, RunnerSupervisor } from "./runtime.ts";

export interface ReadOnly12306Adapter {
  sessionState(): Promise<"READY" | "AUTH_REQUIRED" | "HUMAN_ACTION_REQUIRED">;
  readPendingOrders(): Promise<Awaited<ReturnType<PendingOrderReader["readPending"]>>>;
}

export class Scheduler { nextSaleCheck(task: TaskSpec, now = new Date()) { return { task_id: task.task_id, at: task.deadline ?? now.toISOString(), state: "WAITING_FOR_SALE" as const }; } }
export class TaskCache { private readonly tasks = new Map<string, TaskSpec>(); put(task: TaskSpec) { this.tasks.set(task.task_id, task); } get(taskId: string) { return this.tasks.get(taskId); } }
export class AuthorizationVerifier { verify(arm: ArmLease, task: TaskSpec, principal: string, runnerRef: string, now = new Date()) { assertArm(arm, task, principal, runnerRef, now); return true; } }
export class SessionManager { private readonly adapter: ReadOnly12306Adapter; constructor(adapter: ReadOnly12306Adapter) { this.adapter = adapter; } async readiness() { return this.adapter.sessionState(); } }
export class ClockSync { serverOffsetMs = 0; update(serverNowMs: number, localNowMs = Date.now()) { this.serverOffsetMs = serverNowMs - localNowMs; return this.serverOffsetMs; } }
export class SelectionEngine { select(candidates: Candidate[]) { return [...candidates].sort((a, b) => a.priority - b.priority)[0]; } }

export class LocalRunner {
  readonly supervisor: RunnerSupervisor;
  readonly cache = new TaskCache();
  readonly scheduler = new Scheduler();
  readonly auth = new AuthorizationVerifier();
  readonly clock = new ClockSync();
  readonly accounts: AccountLeaseProvider;
  readonly selection = new SelectionEngine();
  readonly ledger: EffectLedgerProvider;
  readonly checkpoints: CheckpointStore;
  readonly notifications = new NotificationOutbox();
  private readonly adapter: ReadOnly12306Adapter;

  constructor(
    runnerRef: string,
    adapter: ReadOnly12306Adapter,
    checkpoints = new CheckpointStore(),
    accounts: AccountLeaseProvider = new AccountLeaseManager(),
    ledger: EffectLedgerProvider = new EffectLedger(),
  ) {
    this.supervisor = new RunnerSupervisor(runnerRef);
    this.adapter = adapter;
    this.checkpoints = checkpoints;
    this.accounts = accounts;
    this.ledger = ledger;
  }

  async readOnlyPreflight(task: TaskSpec): Promise<{ state: TicketState; session: string; pending_count: number }> { this.cache.put(task); const session = await new SessionManager(this.adapter).readiness(); if (session !== "READY") return { state: session, session, pending_count: 0 }; const pending = await this.adapter.readPendingOrders(); return { state: "PROBED", session, pending_count: pending.length }; }
  resume(taskId: string) { return this.supervisor.resume(this.checkpoints.load(taskId)); }
  submitOrder(): never { throw new Error("CAPABILITY_NOT_AVAILABLE"); }
}

export type LocalRunnerSnapshot = { runner: ReturnType<RunnerSupervisor["snapshot"]>; checkpoint?: Checkpoint; effects: EffectRecord[] };