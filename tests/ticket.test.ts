import test from "node:test";
import assert from "node:assert/strict";
import { TicketControlPlane } from "../src/ticket/control.ts";
import { Fake12306Adapter } from "../runner/fake12306.ts";
import { AccountLeaseManager } from "../runner/runtime.ts";
import { makeTargetSet, type Candidate, type TaskSpec } from "../src/ticket/contracts.ts";

function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return { task_id: "t-1", task_revision: 1, travel_date: "2026-10-01", origin: "GZQ", destination: "CSQ", passenger_refs: ["psg_self"], target_set: makeTargetSet({ target_set_id: "targets-1", candidates: [{ candidate_id: "c-1", train_code: "G100", seat_classes: ["二等座"], quantity: 1, priority: 1 }] }), account_ref: "account-1", runner_ref: "runner-1", query_budget: 10, time_budget_ms: 60_000, submit_budget: 1, deadline: "2026-10-01T00:00:00.000Z", ...overrides };
}

function prepared(input = task(), principal = "principal-1", runner = "runner-1") { const control = new TicketControlPlane(); control.prepare(input); control.arm(input.task_id, principal, runner, "2099-01-01T00:00:00.000Z"); return control; }

test("normal fake path ends in WAITING_FOR_PAYMENT", async () => {
  const input = task(); const control = prepared(input); const adapter = new Fake12306Adapter(control); const result = await adapter.run(input, "principal-1", "runner-1");
  assert.equal(result.state, "WAITING_FOR_PAYMENT"); assert.ok(result.order_id); assert.equal(result.notification.ok, true); assert.equal(adapter.effects.length, 1); assert.equal(adapter.accountLeaseManager.isHeld(input.account_ref), true);
});

test("wrong principal, expired, replay and revocation are rejected", async () => {
  await assert.rejects(async () => { const input=task(); const c=prepared(input); await new Fake12306Adapter(c).run(input, "other", "runner-1"); }, /WRONG_PRINCIPAL/);
  await assert.rejects(async () => { const input=task(); const c=new TicketControlPlane(); c.prepare(input); c.arm("t-1","principal-1","runner-1","2020-01-01T00:00:00.000Z"); await new Fake12306Adapter(c).run(input,"principal-1","runner-1"); }, /ARM_EXPIRED/);
  const input=task(); const c=prepared(input); const a=new Fake12306Adapter(c); await a.run(input,"principal-1","runner-1"); await assert.rejects(()=>a.run(input,"principal-1","runner-1"), /EXISTING_PENDING_ORDER/);
  const r=prepared(input); r.disarm("t-1"); await assert.rejects(()=>new Fake12306Adapter(r).run(input,"principal-1","runner-1"), /ARM_REPLAY|ARM_REVOKED/);
});

test("response loss enters OUTCOME_UNKNOWN then RECONCILING before pending readback", async () => {
  const input = task(); const control = prepared(input); const adapter = new Fake12306Adapter(control); const result = await adapter.run(input, "principal-1", "runner-1", ["response_loss"]);
  assert.equal(result.state, "WAITING_FOR_PAYMENT");
  assert.deepEqual(adapter.stateHistory.slice(-4), ["OUTCOME_UNKNOWN", "RECONCILING", "ORDER_LOCKED", "WAITING_FOR_PAYMENT"]);
  assert.equal(adapter.effects.filter(effect => effect.effect === "SUBMIT_ORDER").length, 1);
  assert.deepEqual(adapter.effectTransitions.filter(t => t.effect_id === adapter.effects[0].effect_id).map(t => t.to_state), ["STARTED", "UNKNOWN", "RECONCILING", "COMPLETED"]);
});

test("network timeout reconciles and never blind-retries submit", async () => {
  const input=task(); const control=prepared(input); const adapter=new Fake12306Adapter(control); const result=await adapter.run(input,"principal-1","runner-1",["network_timeout"]);
  assert.equal(result.state,"BLOCKED"); assert.equal(result.error_code,"NO_EFFECT_VERIFIED_NO_RETRY"); assert.equal(adapter.effects.filter(effect=>effect.effect==="SUBMIT_ORDER").length,1); assert.equal(adapter.accountLeaseManager.isHeld(input.account_ref),false);
  assert.ok(adapter.stateHistory.includes("OUTCOME_UNKNOWN")); assert.ok(adapter.stateHistory.includes("RECONCILING"));
});

test("re-preparing a task invalidates its previous arm", async () => {
  const input=task(); const control = prepared(input);
  const changed = { ...input, target_set: makeTargetSet({ target_set_id: "changed", candidates: [{ candidate_id: "c-2", train_code: "G102", seat_classes: ["二等座"], quantity: 1, priority: 1 }] }) };
  assert.equal(control.prepare(changed).task_revision, 2);
  await assert.rejects(()=>new Fake12306Adapter(control).run(changed, "principal-1", "runner-1"), /ARM_REPLAY|STALE_ARM|TARGET_CHANGED/);
});

test("session expiry, challenge and notification failure are isolated", async () => {
  const input=task(); const c1=prepared(input); assert.equal((await new Fake12306Adapter(c1).run(input,"principal-1","runner-1",["session_expired"])).state,"AUTH_REQUIRED");
  const c2=prepared(input); assert.equal((await new Fake12306Adapter(c2).run(input,"principal-1","runner-1",["challenge"])).state,"HUMAN_ACTION_REQUIRED");
  const c3=prepared(input); const result=await new Fake12306Adapter(c3).run(input,"principal-1","runner-1",["notification_failure"]); assert.equal(result.state,"WAITING_FOR_PAYMENT"); assert.equal(result.notification.ok,false);
});

test("multiple authorized candidates still create exactly one submit effect", async () => {
  const candidates: Candidate[]=[{candidate_id:"late",train_code:"G102",seat_classes:["二等座"],quantity:1,priority:2},{candidate_id:"first",train_code:"G100",seat_classes:["二等座"],quantity:1,priority:1}];
  const input=task({target_set:makeTargetSet({target_set_id:"multi",candidates})}); const control=prepared(input); const adapter=new Fake12306Adapter(control); const result=await adapter.run(input,"principal-1","runner-1");
  assert.equal(result.state,"WAITING_FOR_PAYMENT"); assert.equal(adapter.effects.filter(effect=>effect.effect==="SUBMIT_ORDER").length,1);
});

test("shared account lease prevents a second concurrent commit lane", async () => {
  const accounts=new AccountLeaseManager();
  const first=task({task_id:"t-a"}); const second=task({task_id:"t-b"});
  const c1=prepared(first); const c2=prepared(second);
  const a1=new Fake12306Adapter(c1,accounts); const a2=new Fake12306Adapter(c2,accounts);
  const firstRun=a1.run(first,"principal-1","runner-1");
  await assert.rejects(()=>a2.run(second,"principal-1","runner-1"),/BLOCKED_RESOURCE_BUSY/);
  const firstResult=await firstRun; assert.equal(firstResult.state,"WAITING_FOR_PAYMENT"); assert.equal(a1.effects.length,1); assert.equal(a2.effects.length,0);
});