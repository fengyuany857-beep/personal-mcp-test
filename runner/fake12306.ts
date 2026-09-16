import { type EffectRecord, type ExecutionResult, type PendingOrder, type TaskSpec, type TicketState } from "../src/ticket/contracts.ts";
import { TicketControlPlane } from "../src/ticket/control.ts";
import { AccountLeaseManager, EffectLedger, FakePendingOrderReader, OutcomeReconciler } from "./runtime.ts";

export type FakeFault = "network_timeout" | "response_loss" | "session_expired" | "challenge" | "notification_failure";

export class Fake12306Adapter {
  readonly effects: EffectRecord[];
  readonly stateHistory: TicketState[] = [];
  private pending: PendingOrder | undefined;
  private readonly control: TicketControlPlane;
  private readonly accounts: AccountLeaseManager;
  private readonly ledger: EffectLedger;

  constructor(control: TicketControlPlane, accounts = new AccountLeaseManager(), ledger = new EffectLedger()) {
    this.control = control;
    this.accounts = accounts;
    this.ledger = ledger;
    this.effects = this.ledger.records;
  }

  get effectTransitions() { return this.ledger.transitions; }
  get accountLeaseManager() { return this.accounts; }

  async run(task: TaskSpec, principal: string, runnerRef: string, faults: FakeFault[] = []): Promise<ExecutionResult> {
    if (this.pending) throw new Error("EXISTING_PENDING_ORDER");
    if (faults.includes("session_expired")) return this.fail(task.task_id, "AUTH_REQUIRED");
    if (faults.includes("challenge")) return this.fail(task.task_id, "HUMAN_ACTION_REQUIRED");

    const arm = this.control.validateAuthorization(task.task_id, principal, runnerRef);
    const candidate = [...task.target_set.candidates].sort((a, b) => a.priority - b.priority)[0];
    if (!candidate) return this.fail(task.task_id, "BLOCKED", "NO_CANDIDATE");

    this.transition(task.task_id, "SEARCHING");
    this.transition(task.task_id, "COMMIT_CANDIDATE_SELECTED");
    const leaseKey = this.accounts.acquire(task.account_ref);
    let keepLease = false;

    try {
      this.control.consumeAuthorization(task.task_id, arm.nonce);
      this.transition(task.task_id, "SUBMITTING");
      const effect = this.ledger.start(task.task_id, "SUBMIT_ORDER");

      // Yield once while the account lease is held so concurrency tests can
      // prove a second commit lane cannot enter the same account resource.
      await Promise.resolve();

      const responseLost = faults.includes("response_loss");
      const timedOut = faults.includes("network_timeout");

      if (responseLost) {
        // Simulate: the provider applied the order, but the response was lost.
        this.pending = this.makePending(task, candidate.train_code);
      } else if (!timedOut) {
        this.pending = this.makePending(task, candidate.train_code);
      }

      if (responseLost || timedOut) {
        this.ledger.markUnknown(effect.effect_id, responseLost ? "response_lost_after_possible_apply" : "network_timeout_after_invocation");
        this.transition(task.task_id, "OUTCOME_UNKNOWN", "SUBMIT_OUTCOME_UNKNOWN");
        this.ledger.markReconciling(effect.effect_id);
        this.transition(task.task_id, "RECONCILING");

        const reconciliation = await new OutcomeReconciler(new FakePendingOrderReader(this.pending ? [this.pending] : [])).reconcile(task);
        if (reconciliation === "ORDER_LOCKED" && this.pending) {
          this.ledger.complete(effect.effect_id, "pending_order_readback_verified");
          this.transition(task.task_id, "ORDER_LOCKED");
          keepLease = true;
          const result = this.control.lockPending(task, this.pending);
          this.stateHistory.push("WAITING_FOR_PAYMENT");
          if (faults.includes("notification_failure")) result.notification = { ok: false, kind: "PENDING_ORDER", error: "NOTIFICATION_FAILED" };
          return result;
        }

        this.ledger.block(effect.effect_id, reconciliation === "NO_EFFECT_VERIFIED" ? "no_effect_verified_submit_not_retried" : "ambiguous_pending_state");
        return this.fail(task.task_id, "BLOCKED", reconciliation === "NO_EFFECT_VERIFIED" ? "NO_EFFECT_VERIFIED_NO_RETRY" : "RECONCILIATION_BLOCKED");
      }

      this.ledger.complete(effect.effect_id, "fake_provider_response_and_pending_state_observed");
      this.transition(task.task_id, "QUEUED");
      this.transition(task.task_id, "ORDER_ID_OBSERVED");
      this.transition(task.task_id, "ORDER_LOCKED");
      keepLease = true;
      const result = this.control.lockPending(task, this.pending!);
      this.stateHistory.push("WAITING_FOR_PAYMENT");
      if (faults.includes("notification_failure")) result.notification = { ok: false, kind: "PENDING_ORDER", error: "NOTIFICATION_FAILED" };
      return result;
    } finally {
      if (!keepLease) this.accounts.release(leaseKey);
    }
  }

  private makePending(task: TaskSpec, train_code: string): PendingOrder {
    return { order_id: `fake-${crypto.randomUUID()}`, task_id: task.task_id, status: "WAITING_FOR_PAYMENT", travel_date: task.travel_date, train_code, redacted: true };
  }

  private transition(task_id: string, state: TicketState, error_code?: string) {
    this.stateHistory.push(state);
    return this.control.transition(task_id, state, error_code);
  }

  private fail(task_id: string, state: TicketState, error_code = state): ExecutionResult {
    const result = { task_id, state, error_code, notification: { ok: true, kind: "NONE" as const } };
    this.stateHistory.push(state);
    this.control.recordResult(result);
    return result;
  }
}