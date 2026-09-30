import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TEACHING_PRESETS, getTeachingPreset } from "./presets.ts";
import {
  commitResponse,
  createTeachingState,
  decodeTeachingState,
  encodeTeachingState,
  prepareAttempt,
  recordEvaluation,
  selectNextActivity,
  teachingSnapshot,
  tutorContractFor
} from "./engine.ts";

const activityKind = z.enum([
  "diagnostic",
  "guided_practice",
  "practice",
  "retrieval",
  "misconception_repair",
  "transfer",
  "feynman"
]);

function ok(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function fail(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  const value = { ok: false, code };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true
  };
}

export function registerTeachingTools(server: McpServer) {
  server.registerTool(
    "teaching.list_curricula",
    {
      description:
        "List deterministic teaching curricula built into Lattice. The curriculum controls concepts, prerequisites, outcomes, and domain guardrails while the conversational model writes the actual lesson.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
        destructiveHint: false
      }
    },
    async () => ok({
      ok: true,
      curricula: Object.values(TEACHING_PRESETS).map(preset => ({
        id: preset.id,
        title: preset.title,
        description: preset.description,
        conceptCount: preset.concepts.length,
        domainRules: preset.domainRules
      }))
    })
  );

  server.registerTool(
    "teaching.start",
    {
      description:
        "Start a portable teaching state. V1 keeps learner state in a returned state_token instead of public Worker storage. Pass that token to later teaching tools.",
      inputSchema: z.object({
        preset: z.string().default("mixing.eq.core.v1"),
        goal: z.string().min(1).max(1000).optional()
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: false,
        destructiveHint: false
      }
    },
    async ({ preset, goal }) => {
      try {
        const curriculum = getTeachingPreset(preset);
        const state = createTeachingState(preset, goal ?? curriculum.title);
        const next = selectNextActivity(state);
        return ok({
          ok: true,
          state_token: encodeTeachingState(state),
          curriculum: {
            id: curriculum.id,
            title: curriculum.title,
            description: curriculum.description,
            concepts: curriculum.concepts.map(c => ({
              id: c.id,
              title: c.title,
              prerequisites: c.prerequisites,
              outcome: c.outcome
            })),
            domainRules: curriculum.domainRules
          },
          next_activity: next
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "teaching.next_activity",
    {
      description:
        "Choose one next learning activity from prerequisite readiness, active misconceptions, review timing, transfer evidence, and a bounded knowledge estimate.",
      inputSchema: z.object({
        state_token: z.string().min(10).max(60000)
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
        destructiveHint: false
      }
    },
    async ({ state_token }) => {
      try {
        const state = decodeTeachingState(state_token);
        return ok({
          ok: true,
          state_token,
          state_revision: state.revision,
          next_activity: selectNextActivity(state)
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "teaching.prepare_attempt",
    {
      description:
        "Freeze a task and rubric before the learner answers. Use before any activity that may update learner evidence so the rubric cannot drift after seeing the response.",
      inputSchema: z.object({
        state_token: z.string().min(10).max(60000),
        concept_id: z.string().min(1).max(120),
        activity_kind: activityKind,
        task: z.string().min(1).max(8000),
        rubric: z.array(z.object({
          criterion: z.string().min(1).max(500),
          weight: z.number().positive().max(100)
        })).min(1).max(8)
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: false,
        destructiveHint: false
      }
    },
    async ({ state_token, concept_id, activity_kind, task, rubric }) => {
      try {
        const state = decodeTeachingState(state_token);
        const result = prepareAttempt(state, concept_id, activity_kind, task, rubric);
        return ok({
          ok: true,
          state_token: encodeTeachingState(result.state),
          state_revision: result.state.revision,
          attempt: result.attempt,
          tutor_contract: tutorContractFor(activity_kind)
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "teaching.commit_response",
    {
      description:
        "Commit the learner response before grading. Stores only a SHA-256 digest and response length in the portable state, proving an attempt existed before evaluation.",
      inputSchema: z.object({
        state_token: z.string().min(10).max(60000),
        attempt_id: z.string().uuid(),
        learner_response: z.string().min(1).max(20000),
        confidence: z.number().int().min(1).max(5).optional()
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: false,
        destructiveHint: false
      }
    },
    async ({ state_token, attempt_id, learner_response, confidence }) => {
      try {
        const state = decodeTeachingState(state_token);
        const next = await commitResponse(state, attempt_id, learner_response, confidence);
        return ok({
          ok: true,
          state_token: encodeTeachingState(next),
          state_revision: next.revision,
          attempt_id,
          response_committed: true,
          response_hash: next.pendingAttempt?.responseHash
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "teaching.record_evaluation",
    {
      description:
        "Record rubric-based evaluation only after teaching.commit_response. Updates knowledge estimate, evidence type, misconceptions, review timing, and transfer evidence. A high estimate alone is never labeled mastery.",
      inputSchema: z.object({
        state_token: z.string().min(10).max(60000),
        attempt_id: z.string().uuid(),
        score: z.number().min(0).max(1),
        misconceptions: z.array(z.string().min(1).max(120)).max(8).optional(),
        resolved_misconceptions: z.array(z.string().min(1).max(120)).max(8).optional(),
        evaluator: z.enum(["model", "human"]).default("model"),
        evidence_strength: z.enum(["low", "medium", "high"]).default("medium")
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: false,
        destructiveHint: false
      }
    },
    async ({
      state_token,
      attempt_id,
      score,
      misconceptions,
      resolved_misconceptions,
      evaluator,
      evidence_strength
    }) => {
      try {
        const state = decodeTeachingState(state_token);
        const result = recordEvaluation(
          state,
          attempt_id,
          score,
          misconceptions ?? [],
          resolved_misconceptions ?? [],
          evaluator,
          evidence_strength
        );
        return ok({
          ok: true,
          state_token: encodeTeachingState(result.state),
          state_revision: result.state.revision,
          concept_status: result.conceptStatus,
          feedback_contract: result.feedbackContract,
          next_activity: selectNextActivity(result.state)
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "teaching.snapshot",
    {
      description:
        "Inspect learner evidence: estimated knowledge, demonstrated evidence, transfer evidence, attempts, review dates, and active misconceptions. This is learning-control state, not psychometric certification.",
      inputSchema: z.object({
        state_token: z.string().min(10).max(60000)
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
        destructiveHint: false
      }
    },
    async ({ state_token }) => {
      try {
        const state = decodeTeachingState(state_token);
        return ok({
          ok: true,
          state_token,
          snapshot: teachingSnapshot(state)
        });
      } catch (error) {
        return fail(error);
      }
    }
  );
}
