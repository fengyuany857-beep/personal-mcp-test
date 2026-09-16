import test from "node:test";
import assert from "node:assert/strict";
import { CheckpointStore, EffectLedger, FakePendingOrderReader, OutcomeReconciler, RunnerSupervisor, checkpointFor } from "../runner/runtime.ts";
import { makeTargetSet, type TaskSpec } from "../src/ticket/contracts.ts";
import { LocalRunner } from "../runner/local-runner.ts";

const task: TaskSpec = { task_id: "t-runtime", task_revision: 1, travel_date: "2026-10-01", origin: "GZQ", destination: "CSQ", passenger_refs: ["psg_self"], target_set: makeTargetSet({ target_set_id: "rt", candidates: [{ candidate_id: "c", train_code: "G100", seat_classes: ["二等座"], quantity: 1, priority: 1 }] }), account_ref: "a", runner_ref: "r", query_budget: 1, time_budget_ms: 1_000, submit_budget: 1, deadline: "2026-10-01T00:00:00Z" };

test("effect ledger preserves unknown non-idempotent submit", () => { const ledger = new EffectLedger(); const e=ledger.start(task.task_id,"SUBMIT_ORDER"); assert.equal(e.semantics,"NON_IDEMPOTENT_UNKNOWN"); ledger.markUnknown(e.effect_id); assert.equal(ledger.records[0].state,"UNKNOWN"); });
test("checkpoint and runner restart are recoverable", () => { const store=new CheckpointStore(); store.save(checkpointFor(task,"QUEUED",["effect-1"],"c")); assert.equal(store.load(task.task_id)?.state,"QUEUED"); const runner=new RunnerSupervisor("r"); assert.equal(runner.start().state,"READY"); assert.equal(runner.stop().online,false); });
test("reconciler distinguishes match, no effect and ambiguous state", async () => { assert.equal(await new OutcomeReconciler(new FakePendingOrderReader([{ order_id:"o", task_id:task.task_id, status:"WAITING_FOR_PAYMENT", redacted:true }])).reconcile(task),"ORDER_LOCKED"); assert.equal(await new OutcomeReconciler(new FakePendingOrderReader()).reconcile(task),"NO_EFFECT_VERIFIED"); assert.equal(await new OutcomeReconciler(new FakePendingOrderReader([{ order_id:"other", status:"UNKNOWN", redacted:true }])).reconcile(task),"BLOCKED"); });
test("local runner preflight is read-only and submit is unavailable", async () => { const runner=new LocalRunner("r", { sessionState:async()=>"READY", readPendingOrders:async()=>[] }); const result=await runner.readOnlyPreflight(task); assert.equal(result.state,"PROBED"); assert.equal(result.pending_count,0); assert.throws(()=>runner.submitOrder(),/CAPABILITY_NOT_AVAILABLE/); });
