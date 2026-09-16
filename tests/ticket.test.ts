import test from "node:test";
import assert from "node:assert/strict";
import { TicketControlPlane } from "../src/ticket/control.ts";
import { Fake12306Adapter } from "../runner/fake12306.ts";
import { makeTargetSet, type TaskSpec } from "../src/ticket/contracts.ts";

function task(): TaskSpec {
  return { task_id: "t-1", task_revision: 1, travel_date: "2026-10-01", origin: "GZQ", destination: "CSQ", passenger_refs: ["psg_self"], target_set: makeTargetSet({ target_set_id: "targets-1", candidates: [{ candidate_id: "c-1", train_code: "G100", seat_classes: ["二等座"], quantity: 1, priority: 1 }] }), account_ref: "account-1", runner_ref: "runner-1", query_budget: 10, time_budget_ms: 60_000, submit_budget: 1, deadline: "2026-10-01T00:00:00.000Z" };
}

function prepared() { const control = new TicketControlPlane(); control.prepare(task()); control.arm("t-1", "principal-1", "runner-1", "2099-01-01T00:00:00.000Z"); return control; }

test("normal fake path ends in WAITING_FOR_PAYMENT", () => {
  const control = prepared(); const result = new Fake12306Adapter(control).run(task(), "principal-1", "runner-1");
  assert.equal(result.state, "WAITING_FOR_PAYMENT"); assert.ok(result.order_id); assert.equal(result.notification.ok, true);
});

test("wrong principal, expired, replay and revocation are rejected", () => {
  assert.throws(() => { const c=prepared(); new Fake12306Adapter(c).run(task(), "other", "runner-1"); }, /WRONG_PRINCIPAL/);
  assert.throws(() => { const c=new TicketControlPlane(); c.prepare(task()); c.arm("t-1","principal-1","runner-1","2020-01-01T00:00:00.000Z"); new Fake12306Adapter(c).run(task(),"principal-1","runner-1"); }, /ARM_EXPIRED/);
  const c=prepared(); const a=new Fake12306Adapter(c); a.run(task(),"principal-1","runner-1"); assert.throws(() => a.run(task(),"principal-1","runner-1"), /EXISTING_PENDING_ORDER/);
  const r=prepared(); r.disarm("t-1"); assert.throws(() => new Fake12306Adapter(r).run(task(),"principal-1","runner-1"), /ARM_REPLAY|ARM_REVOKED/);
});

test("response loss reconciles without a blind retry", () => {
  const control = prepared(); const adapter = new Fake12306Adapter(control); const result = adapter.run(task(), "principal-1", "runner-1", ["response_loss"]);
  assert.equal(result.state, "WAITING_FOR_PAYMENT"); assert.equal(adapter.effects.length, 1); assert.equal(control.status().pending_order_state, "WAITING_FOR_PAYMENT");
});

test("re-preparing a task invalidates its previous arm", () => {
  const control = prepared();
  const changed = { ...task(), target_set: makeTargetSet({ target_set_id: "changed", candidates: [{ candidate_id: "c-2", train_code: "G102", seat_classes: ["二等座"], quantity: 1, priority: 1 }] }) };
  assert.equal(control.prepare(changed).task_revision, 2);
  assert.throws(() => new Fake12306Adapter(control).run(changed, "principal-1", "runner-1"), /ARM_REPLAY|STALE_ARM|TARGET_CHANGED/);
});

test("session expiry, challenge and notification failure are isolated", () => {
  const c1=prepared(); assert.equal(new Fake12306Adapter(c1).run(task(),"principal-1","runner-1",["session_expired"]).state,"AUTH_REQUIRED");
  const c2=prepared(); assert.equal(new Fake12306Adapter(c2).run(task(),"principal-1","runner-1",["challenge"]).state,"HUMAN_ACTION_REQUIRED");
  const c3=prepared(); const result=new Fake12306Adapter(c3).run(task(),"principal-1","runner-1",["notification_failure"]); assert.equal(result.state,"WAITING_FOR_PAYMENT"); assert.equal(result.notification.ok,false);
});
