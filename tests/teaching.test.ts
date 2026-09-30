import assert from "node:assert/strict";
import test from "node:test";
import {
  commitResponse,
  createTeachingState,
  decodeTeachingState,
  encodeTeachingState,
  prepareAttempt,
  recordEvaluation,
  selectNextActivity,
  teachingSnapshot
} from "../src/teaching/engine.ts";

test("portable teaching state round-trips", () => {
  const state=createTeachingState("mixing.eq.core.v1","Learn EQ");
  const restored=decodeTeachingState(encodeTeachingState(state));
  assert.equal(restored.presetId,"mixing.eq.core.v1");
  assert.equal(restored.goal,"Learn EQ");
  assert.equal(restored.revision,1);
});

test("first activity is an EQ controls diagnostic", () => {
  const state=createTeachingState("mixing.eq.core.v1","Learn EQ");
  const next=selectNextActivity(state);
  assert.equal(next.conceptId,"eq_controls");
  assert.equal(next.kind,"diagnostic");
});

test("attempt must be committed before evaluation", () => {
  const state=createTeachingState("mixing.eq.core.v1","Learn EQ");
  const prepared=prepareAttempt(
    state,
    "eq_controls",
    "diagnostic",
    "Explain Frequency, Gain, and Q.",
    [{criterion:"Explains all three controls",weight:1}]
  );
  assert.throws(
    ()=>recordEvaluation(prepared.state,prepared.attempt.id,1,[],[],"model","medium"),
    /RESPONSE_NOT_COMMITTED/
  );
});

test("attempt lifecycle updates evidence without granting mastery immediately", async () => {
  const state=createTeachingState("mixing.eq.core.v1","Learn EQ",new Date("2026-09-30T00:00:00Z"));
  const prepared=prepareAttempt(
    state,
    "eq_controls",
    "diagnostic",
    "Explain Frequency, Gain, and Q.",
    [
      {criterion:"Frequency identifies the target area",weight:1},
      {criterion:"Gain changes level",weight:1},
      {criterion:"Q changes bandwidth",weight:1}
    ],
    new Date("2026-09-30T00:01:00Z")
  );
  const committed=await commitResponse(
    prepared.state,
    prepared.attempt.id,
    "Frequency chooses where, gain changes level, and Q controls bandwidth.",
    4,
    new Date("2026-09-30T00:02:00Z")
  );
  assert.ok(committed.pendingAttempt?.responseHash);

  const evaluated=recordEvaluation(
    committed,
    prepared.attempt.id,
    0.95,
    [],
    [],
    "model",
    "medium",
    new Date("2026-09-30T00:03:00Z")
  );
  assert.equal(evaluated.state.pendingAttempt,undefined);
  assert.equal(evaluated.state.concepts.eq_controls.attempts,1);
  assert.ok(evaluated.state.concepts.eq_controls.pKnown>0.25);
  assert.equal(evaluated.conceptStatus.masteryReady,false);
});

test("snapshot keeps estimate, demonstration, and transfer separate", () => {
  const state=createTeachingState("mixing.eq.core.v1","Learn EQ");
  state.concepts.eq_controls.pKnown=0.95;
  state.concepts.eq_controls.attempts=4;
  const concept=teachingSnapshot(state).concepts.find(x=>x.id==="eq_controls");
  assert.equal(concept?.estimated,0.95);
  assert.equal(concept?.demonstrated,false);
  assert.equal(concept?.transferred,false);
  assert.equal(concept?.masteryReady,false);
});
