import { z } from "zod";
import { CONTEXT_FIELDS } from "../shared/types.js";
import { ActionRequest } from "./commands.js";

/**
 * The structured response Nikki (the model) must return on every turn.
 * The JSON Schema below is sent to the API as `output_config.format`; the Zod
 * schema mirrors it and is used to validate every response on the server.
 * Semantic checks (time overlaps, task references, budget) live in validate.ts.
 */

// Kept deliberately small: the API compiles this schema into a grammar and rejects
// schemas that are too complex. Optional values use "" (strings) or 0 (numbers)
// instead of null unions; the server converts those to null after parsing.
const str = { type: "string" };
const int = { type: "integer" };
const refWhy = { type: "object", additionalProperties: false, required: ["task_ref", "why"], properties: { task_ref: str, why: str } };

export const RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message", "questions", "quick_replies", "captured_items", "task_updates", "actions", "meetings", "context_updates", "plan"],
  properties: {
    message: str,
    questions: { type: "array", items: str },
    quick_replies: { type: "array", items: str },
    captured_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "kind", "title", "notes", "estimate_minutes", "deadline", "deadline_time", "planned_date", "priority", "optional", "project", "duplicate_of"],
        properties: {
          ref: str,
          kind: { type: "string", enum: ["action", "idea", "reference"] },
          title: str,
          notes: str,
          estimate_minutes: int,
          deadline: str,
          deadline_time: str,
          planned_date: str,
          priority: { type: "string", enum: ["high", "normal", "low"] },
          optional: { type: "boolean" },
          project: str,
          duplicate_of: str,
        },
      },
    },
    task_updates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task_id", "change", "title", "estimate_minutes", "deadline", "planned_date", "notes", "reason"],
        properties: {
          task_id: str,
          change: { type: "string", enum: ["update", "complete", "waiting", "blocked", "reopen", "delete", "unschedule"] },
          title: str,
          estimate_minutes: int,
          deadline: str,
          planned_date: str,
          notes: str,
          reason: str,
        },
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "task_id", "minutes", "from", "to", "date", "time", "priority", "flag"],
        properties: {
          type: { type: "string", enum: ["start", "pause", "finish", "report_time", "set_priority", "set_optional", "set_deadline", "move_day", "reopen"] },
          task_id: str,
          minutes: int,
          from: str,
          to: str,
          date: str,
          time: str,
          priority: { type: "string", enum: ["high", "normal", "low", ""] },
          flag: { type: "boolean" },
        },
      },
    },
    meetings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "title", "start", "end"],
        properties: { date: str, title: str, start: str, end: str },
      },
    },
    context_updates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "field", "value", "reason"],
        properties: {
          action: { type: "string", enum: ["add", "remove", "set"] },
          field: { type: "string", enum: [...CONTEXT_FIELDS] },
          value: str,
          reason: str,
        },
      },
    },
    plan: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["date", "main_outcome", "focus", "supporting", "deferred", "window", "work_budget_minutes", "blocks", "reasons", "assumptions"],
          properties: {
            date: str,
            main_outcome: str,
            focus: refWhy,
            supporting: { type: "array", items: refWhy },
            deferred: { type: "array", items: refWhy },
            window: { type: "object", additionalProperties: false, required: ["start", "end"], properties: { start: str, end: str } },
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
                  task_ref: str,
                  title: str,
                },
              },
            },
            reasons: { type: "array", items: str },
            assumptions: { type: "array", items: str },
          },
        },
        { type: "null" },
      ],
    },
  },
} as const;

/** "" / whitespace -> null */
const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().nullable());
/** 0 -> null */
const optMinutes = z.preprocess((v) => (v === 0 ? null : v), z.number().int().positive().max(24 * 60).nullable());

const ref = z.object({ task_ref: z.string().min(1), why: z.string() });

export const ModelResponse = z.object({
  message: z.string(),
  questions: z.array(z.string()),
  quick_replies: z.array(z.string().max(120)).optional().default([]),
  captured_items: z.array(
    z.object({
      ref: z.string().min(1),
      kind: z.enum(["action", "idea", "reference"]),
      title: z.string().min(1).max(300),
      notes: optStr,
      estimate_minutes: optMinutes,
      deadline: optStr,
      deadline_time: optStr.optional().default(null),
      planned_date: optStr.optional().default(null),
      priority: z.enum(["high", "normal", "low"]).optional().default("normal"),
      optional: z.boolean().optional().default(false),
      project: optStr,
      duplicate_of: optStr,
    }),
  ),
  task_updates: z.array(
    z.object({
      task_id: z.string(),
      change: z.enum(["update", "complete", "waiting", "blocked", "reopen", "delete", "unschedule"]),
      title: optStr,
      estimate_minutes: optMinutes,
      deadline: optStr,
      planned_date: optStr.optional().default(null),
      notes: optStr,
      reason: z.string(),
    }),
  ),
  actions: z.array(ActionRequest).optional().default([]),
  meetings: z.array(z.object({ date: optStr.optional().default(null), title: z.string().min(1), start: z.string(), end: z.string() })),
  context_updates: z.array(
    z.object({
      action: z.enum(["add", "remove", "set"]).optional().default("add"),
      field: z.enum(CONTEXT_FIELDS),
      value: z.string(),
      reason: z.string(),
    }),
  ),
  availability: z
    .object({
      window_start: z.string().nullable(),
      window_end: z.string().nullable(),
      work_budget_minutes: z.number().int().nonnegative().nullable(),
      budget_excludes_meetings: z.boolean().nullable(),
    })
    .nullable()
    .optional()
    .default(null),
  plan: z
    .object({
      date: optStr.optional().default(null),
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
          task_ref: optStr,
          title: z.string(),
        }),
      ),
      reasons: z.array(z.string()),
      assumptions: z.array(z.string()),
    })
    .nullable(),
});

export type ModelResponse = z.infer<typeof ModelResponse>;
