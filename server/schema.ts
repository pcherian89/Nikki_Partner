import { z } from "zod";
import { CONTEXT_FIELDS } from "../shared/types.js";

/**
 * The structured response Nikki (the model) must return on every turn.
 * The JSON Schema below is sent to the API as `output_config.format`; the Zod
 * schema mirrors it and is used to validate every response on the server.
 * Semantic checks (time overlaps, task references, budget) live in validate.ts.
 */

const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const str = { type: "string" };
const int = { type: "integer" };

export const RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "message",
    "questions",
    "captured_items",
    "task_updates",
    "meetings",
    "context_updates",
    "availability",
    "plan",
  ],
  properties: {
    message: { type: "string", description: "Short, supportive reply shown to the user." },
    questions: {
      type: "array",
      description: "At most two clarification questions. Empty if none are needed.",
      items: str,
    },
    captured_items: {
      type: "array",
      description: "New items the user mentioned in their latest message that are not already saved.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "kind", "title", "notes", "estimate_minutes", "deadline", "project", "duplicate_of"],
        properties: {
          ref: { type: "string", description: "Temporary reference such as n1, n2 used by the plan." },
          kind: { type: "string", enum: ["action", "idea", "reference"] },
          title: str,
          notes: nullable(str),
          estimate_minutes: nullable(int),
          deadline: nullable({ type: "string", description: "YYYY-MM-DD. Only if the user stated a deadline." }),
          project: nullable(str),
          duplicate_of: nullable({ type: "string", description: "Existing task id if this is the same item." }),
        },
      },
    },
    task_updates: {
      type: "array",
      description: "Proposed changes to existing saved tasks. The user must confirm them.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task_id", "change", "title", "estimate_minutes", "deadline", "notes", "reason"],
        properties: {
          task_id: str,
          change: { type: "string", enum: ["update", "complete", "waiting", "blocked", "reopen", "delete"] },
          title: nullable(str),
          estimate_minutes: nullable(int),
          deadline: nullable(str),
          notes: nullable(str),
          reason: str,
        },
      },
    },
    meetings: {
      type: "array",
      description: "Fixed meetings TODAY that the user explicitly stated and that are not already saved.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "start", "end"],
        properties: { title: str, start: { type: "string", description: "HH:MM 24h" }, end: { type: "string", description: "HH:MM 24h" } },
      },
    },
    context_updates: {
      type: "array",
      description: "Suggested updates to the user's saved context. Never saved without user confirmation.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "value", "reason"],
        properties: { field: { type: "string", enum: [...CONTEXT_FIELDS] }, value: str, reason: str },
      },
    },
    availability: nullable({
      type: "object",
      additionalProperties: false,
      required: ["window_start", "window_end", "work_budget_minutes", "budget_excludes_meetings"],
      properties: {
        window_start: nullable(str),
        window_end: nullable(str),
        work_budget_minutes: nullable(int),
        budget_excludes_meetings: nullable({ type: "boolean" }),
      },
    }),
    plan: nullable({
      type: "object",
      additionalProperties: false,
      required: ["main_outcome", "focus", "supporting", "deferred", "window", "work_budget_minutes", "blocks", "reasons", "assumptions"],
      properties: {
        main_outcome: str,
        focus: {
          type: "object",
          additionalProperties: false,
          required: ["task_ref", "why"],
          properties: { task_ref: str, why: str },
        },
        supporting: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["task_ref", "why"], properties: { task_ref: str, why: str } },
        },
        deferred: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["task_ref", "why"], properties: { task_ref: str, why: str } },
        },
        window: {
          type: "object",
          additionalProperties: false,
          required: ["start", "end"],
          properties: { start: str, end: str },
        },
        work_budget_minutes: int,
        blocks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["start", "end", "kind", "task_ref", "title"],
            properties: {
              start: str,
              end: str,
              kind: { type: "string", enum: ["focus", "task", "break", "buffer", "meeting"] },
              task_ref: nullable(str),
              title: str,
            },
          },
        },
        reasons: { type: "array", items: str },
        assumptions: { type: "array", items: str },
      },
    }),
  },
} as const;

const ref = z.object({ task_ref: z.string().min(1), why: z.string() });

export const ModelResponse = z.object({
  message: z.string(),
  questions: z.array(z.string()),
  captured_items: z.array(
    z.object({
      ref: z.string().min(1),
      kind: z.enum(["action", "idea", "reference"]),
      title: z.string().min(1).max(300),
      notes: z.string().nullable(),
      estimate_minutes: z.number().int().positive().max(24 * 60).nullable(),
      deadline: z.string().nullable(),
      project: z.string().nullable(),
      duplicate_of: z.string().nullable(),
    }),
  ),
  task_updates: z.array(
    z.object({
      task_id: z.string(),
      change: z.enum(["update", "complete", "waiting", "blocked", "reopen", "delete"]),
      title: z.string().nullable(),
      estimate_minutes: z.number().int().positive().max(24 * 60).nullable(),
      deadline: z.string().nullable(),
      notes: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  meetings: z.array(z.object({ title: z.string().min(1), start: z.string(), end: z.string() })),
  context_updates: z.array(z.object({ field: z.enum(CONTEXT_FIELDS), value: z.string(), reason: z.string() })),
  availability: z
    .object({
      window_start: z.string().nullable(),
      window_end: z.string().nullable(),
      work_budget_minutes: z.number().int().nonnegative().nullable(),
      budget_excludes_meetings: z.boolean().nullable(),
    })
    .nullable(),
  plan: z
    .object({
      main_outcome: z.string(),
      focus: ref,
      supporting: z.array(ref),
      deferred: z.array(ref),
      window: z.object({ start: z.string(), end: z.string() }),
      work_budget_minutes: z.number().int().nonnegative(),
      blocks: z.array(
        z.object({
          start: z.string(),
          end: z.string(),
          kind: z.enum(["focus", "task", "break", "buffer", "meeting"]),
          task_ref: z.string().nullable(),
          title: z.string(),
        }),
      ),
      reasons: z.array(z.string()),
      assumptions: z.array(z.string()),
    })
    .nullable(),
});

export type ModelResponse = z.infer<typeof ModelResponse>;
