import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { CheckpointStore, EffectLedger, FakePendingOrderReader, JsonFileCheckpointBackend, OutcomeReconciler, RunnerSupervisor, checkpointFor } from "../runner/runtime.ts";
import { makeTargetSet, type TaskSpec } from "../src/ticket/contracts.ts";
import { LocalRunner } from "../runner/local-runner.ts";

const task: TaskSpec = { task_id: "t-runtime", task_revision: 1, travel_date: "2026-10-01", origin: "GZQ", destination: "CSQ", passenger_refs: ["psg_self"], target_set: makeTargetSet({ target_set_id: "rt", candidates: [{ candidate_id: "c", train_code: "G100", seat_classes: ["二等座"], quantity: 1, priority: 1 }] }), account_ref: "a", runner_ref: "r", query_budget: 1, time_budget_ms: 1_000, submit_budget: 1, deadline: "2026-10-01T00:00:00Z" };

test("effect ledger preserves append-only transitions for unknown non-idempotent submit", () => { const ledger = new EffectLedger(); const e=ledger.start(task.task_id,"SUBMIT_ORDER"); assert.equal(e.semantics,"NON_IDEMPOTENT_UNKNOWN"); ledger.markUnknown(e.effect_id); ledger.markReconciling(e.effect_id); assert.equal(ledger.records[0].state,"RECONCILING"); assert.deepEqual(ledger.transitions.map(t=>t.to_state),["STARTED","UNKNOWN","RECONCILING"]); });

test("checkpoint survives a fresh store and runner instance through a file backend", () => {
  const directory=mkdtempSync(join(tmpdir(),"ticket-checkpoint-")); const path=join(directory,"checkpoint.json");
  try {
    const firstStore=new CheckpointStore(new JsonFileCheckpointBackend(path)); firstStore.save(checkpointFor(task,"QUEUED",["effect-1"],"c"));
    const secondStore=new CheckpointStore(new JsonFileCheckpointBackend(path)); assert.equal(secondStore.load(task.task_id)?.state,"QUEUED");
    const firstRunner=new RunnerSupervisor("r"); firstRunner.start(); firstRunner.stop();
    const restartedRunner=new RunnerSupervisor("r"); assert.equal(restartedRunner.resume(secondStore.load(task.task_id)).state,"QUEUED");
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test("reconciler locks only explicit pending-payment orders with a bounded exact match", async () => {
  const multi={...task,target_set:makeTargetSet({target_set_id:"multi",candidates:[...task.target_set.candidates,{candidate_id:"c2",train_code:"G102",seat_classes:["二等座"],quantity:1,priority:2}]})};
  const exact={ order_id:"o", travel_date:task.travel_date, train_code:"G102", origin:task.origin, destination:task.destination, passenger_refs:["psg_self"], seat_classes:["二等座"], quantity:1, status:"WAITING_FOR_PAYMENT" as const, redacted:true as const };
  assert.equal(await new OutcomeReconciler(new FakePendingOrderReader([exact])).reconcile(multi),"ORDER_LOCKED");
  assert.equal(await new OutcomeReconciler(new FakePendingOrderReader()).reconcile(task),"NO_EFFECT_VERIFIED");
  assert.equal(await new OutcomeReconciler(new FakePendingOrderReader([{ ...exact, status:"UNKNOWN" }])).reconcile(multi),"BLOCKED");
  assert.equal(await new OutcomeReconciler(new FakePendingOrderReader([{ ...exact, passenger_refs:["psg_other"] }])).reconcile(multi),"BLOCKED");
  assert.equal(await new OutcomeReconciler(new FakePendingOrderReader([{ order_id:"other", status:"UNKNOWN", redacted:true }])).reconcile(task),"BLOCKED");
});

test("internal fake task identity can reconcile only when status is explicit pending payment", async () => {
  assert.equal(await new OutcomeReconciler(new FakePendingOrderReader([{ order_id:"fake", task_id:task.task_id, status:"WAITING_FOR_PAYMENT", redacted:true }])).reconcile(task),"ORDER_LOCKED");
  assert.equal(await new OutcomeReconciler(new FakePendingOrderReader([{ order_id:"fake", task_id:task.task_id, status:"UNKNOWN", redacted:true }])).reconcile(task),"BLOCKED");
});

test("local runner preflight is read-only, can resume a checkpoint and submit stays unavailable", async () => { const store=new CheckpointStore(); store.save(checkpointFor(task,"RECONCILING",["effect-x"])); const runner=new LocalRunner("r", { sessionState:async()=>"READY", readPendingOrders:async()=>[] },store); const result=await runner.readOnlyPreflight(task); assert.equal(result.state,"PROBED"); assert.equal(result.pending_count,0); assert.equal(runner.resume(task.task_id).state,"RECONCILING"); assert.throws(()=>runner.submitOrder(),/CAPABILITY_NOT_AVAILABLE/); });
