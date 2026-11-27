import { z } from "zod";
import { listTasks, type DB } from "../db.js";
import { UserFacingError } from "../errors.js";
import { logActivity } from "../system/activity.js";
import { actionHandler, proposeAction } from "../system/actions.js";
import { notify } from "../system/notifications.js";
import { levelRank, requireSpace, type Level } from "../system/spaces.js";
import type { AgentConfig } from "./profiles.js";

/**
 * The tool gateway: the ONLY way an agent touches anything. Checked in code on every call, whatever the model says:
 * the tool must be on the agent's allow-list, at or below its permission level, in its own (enabled) space, and
 * within its call limit. Tools at "change" level or above never act directly: they create a proposal that waits for
 * the user's approval in Nikki.
 */

export interface ToolContext {
  db: DB;
  agentId: string;
  config: AgentConfig;
  runId: string;
}

export interface AgentTool<I = any> {
  name: string;
  level: Level;
  description: string;
  input: z.ZodType<I>;
  /** JSON schema sent to the model (strict: additionalProperties false, every property required). */
  jsonSchema: Record<string, unknown>;
  /** Which spaces the tool's data belongs to (Phase 0: Nikki's planning data is the personal space). */
  spaces: string[];
  run: (ctx: ToolContext, input: I) => Promise<unknown> | unknown;
}

const tools = new Map<string, AgentTool>();
export const registerTool = (t: AgentTool) => tools.set(t.name, t);
export const getTool = (name: string) => tools.get(name);
export const listTools = () => [...tools.values()].map((t) => ({ name: t.name, level: t.level, description: t.description, spaces: t.spaces }));

export class ToolDenied extends Error {}

/** Runs one tool call through every check. Returns data the engine wraps as untrusted before the model sees it. */
export async function callTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<unknown> {
  const t = tools.get(name);
  const deny = (why: string) => {
    logActivity(ctx.db, `agent:${ctx.agentId}`, "tool.denied", name, { reason: why }, ctx.config.spaceId);
    throw new ToolDenied(why);
  };
  if (!t) return deny("unknown_tool");
  if (!ctx.config.tools.includes(name)) return deny("not_allowed");
  if (t.level === "prohibited") return deny("prohibited");
  if (levelRank(t.level) > levelRank(ctx.config.maxLevel)) return deny("level");
  if (!t.spaces.includes(ctx.config.spaceId)) return deny("space");
  requireSpace(ctx.db, ctx.config.spaceId, { forAi: ctx.config.useAi });
  const parsed = t.input.safeParse(rawInput);
  if (!parsed.success) throw new ToolDenied(`invalid input: ${parsed.error.issues[0]?.message ?? ""}`);
  logActivity(ctx.db, `agent:${ctx.agentId}`, "tool.called", name, { level: t.level }, ctx.config.spaceId);
  return t.run(ctx, parsed.data);
}

// ---------- Phase 0 tools (Nikki-internal only) ----------

const obj = (props: Record<string, unknown>) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });

registerTool({
  name: "nikki_list_open_tasks",
  level: "read",
  description: "List the user's open tasks in Nikki (title, deadline, priority). Up to 30.",
  input: z.object({}).strict(),
  jsonSchema: obj({}),
  spaces: ["personal"],
  run: (ctx) =>
    listTasks(ctx.db)
      .filter((t) => t.status !== "done")
      .slice(0, 30)
      .map((t) => ({ title: t.title, deadline: t.deadline, priority: t.priority })),
});

function proposeVia(kind: string, title: (p: any) => string) {
  return (ctx: ToolContext, p: Record<string, unknown>) => {
    if (!actionHandler(kind)) throw new UserFacingError("Unknown action.");
    const a = proposeAction(ctx.db, { kind, title: title(p), spaceId: ctx.config.spaceId, params: p, agentId: ctx.agentId, idempotencyKey: `${ctx.runId}:${kind}:${JSON.stringify(p)}` }, `agent:${ctx.agentId}`);
    return { proposed: true, status: a.status, note: "Waiting for the user's approval in Nikki. Nothing has been done yet." };
  };
}

registerTool({
  name: "nikki_propose_task",
  level: "change",
  description: "Propose adding a task to Nikki. The user must approve it; nothing is created until then.",
  input: z.object({ title: z.string().min(1).max(300) }).strict(),
  jsonSchema: obj({ title: { type: "string" } }),
  spaces: ["personal"],
  run: proposeVia("nikki.create_task", (p) => `Add task: ${p.title}`),
});

registerTool({
  name: "nikki_propose_reminder",
  level: "change",
  description: "Propose a reminder (date YYYY-MM-DD, time HH:MM, user's time zone). The user must approve it.",
  input: z.object({ title: z.string().min(1).max(300), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/) }).strict(),
  jsonSchema: obj({ title: { type: "string" }, date: { type: "string" }, time: { type: "string" } }),
  spaces: ["personal"],
  run: proposeVia("nikki.create_reminder", (p) => `Reminder ${p.date} ${p.time}: ${p.title}`),
});

registerTool({
  name: "nikki_notify_user",
  level: "prepare",
  description: "Send the user a short in-app notification (and push, if they allow agent updates).",
  input: z.object({ title: z.string().min(1).max(140), body: z.string().max(600) }).strict(),
  jsonSchema: obj({ title: { type: "string" }, body: { type: "string" } }),
  spaces: ["personal", "revivo", "avagama", "consulting", "other"],
  run: async (ctx, p) => {
    const { item } = await notify(ctx.db, { category: "agent", title: p.title, body: p.body, sensitive: true, spaceId: ctx.config.spaceId, link: "/?view=inbox" });
    return { sent: true, id: item.id };
  },
});
