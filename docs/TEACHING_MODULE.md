# Lattice Teaching Module V1

The module turns Lattice from a retrieval/explanation assistant into a learning controller.

## Loop

1. teaching.start creates a portable learner state.
2. teaching.next_activity selects one concept and one activity.
3. The conversational model generates only the requested task.
4. teaching.prepare_attempt freezes the task and rubric before the learner answers.
5. teaching.commit_response commits a response digest before grading.
6. teaching.record_evaluation updates learning evidence, misconceptions, review timing, and transfer status.
7. teaching.snapshot exposes progress without collapsing estimate, demonstration, and transfer into one number.

## First curriculum

mixing.eq.core.v1 covers EQ controls, source/arrangement before EQ, low-end and HPF decisions, tonal balance, resonance, masking, context A/B, presence/depth, EQ versus harmonic generation, and transfer to orchestration/game music.

The curriculum explicitly rejects fixed-frequency recipes and analyzer-only decisions.

## V1 state boundary

Learner state is carried in an LTM1 state token. It is not persisted on the public Worker and is not a secure credential or certification. A client can modify its own token, so the state is useful for tutoring continuity and routing, not high-stakes proof.

Persistent authenticated storage is intentionally deferred until Lattice has a learner identity boundary or a separately deployed Tutor MCP service.

## Evidence model

Estimated knowledge, demonstrated evidence, transfer evidence, and mastery readiness are separate. Mastery readiness requires repeated evidence plus successful transfer and no active misconception.

The BKT-style estimate and review intervals are bounded teaching heuristics, not psychometric validation.

## Reuse

Design patterns were inspected from Tutor MCP (MIT), especially concept graphs, frozen assessment attempts, knowledge tracing, misconception tracking, transfer checks, and evidence separation. No Tutor MCP source code is vendored here; V1 is implemented natively in TypeScript for the existing Cloudflare Worker.
