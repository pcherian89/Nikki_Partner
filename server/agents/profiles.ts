import { z } from "zod";
import { clockIso, newId, type DB } from "../db.js";
import { UserFacingError } from "../errors.js";
import { logActivity } from "../system/activity.js";
import { upsertJob, setJobEnabled, type Schedule } from "../system/jobs.js";
import { LEVELS, levelRank, requireSpace } from "../system/spaces.js";
import { getTool } from "./tools.js";

/**
 * Agent profiles: configuration, not code. One engine (engine.ts) runs every agent; a profile only chooses the
 * space, the allowed tools, the highest permission level, whether AI is used at all (code-first), the model tier,
 * limits and an optional schedule.
 *
 * Safety rules enforced here:
 * - A profile can never allow "prohibited" tools, and "consequential" work is only ever proposed, never executed.
 * - Only the user can widen permissions (more tools, a higher level, another space, AI on). A profile created or
 *   edited by anything else ("ai", "system") is saved disabled and can't widen permissions.
 * - Confidential spaces can't have AI agents.
 * - New agents are off until the user turns them on.
 */

export const AgentConfigSchema = z
  .object({
    spaceId: z.string(),
    instructions: z.string().max(4000).default(""),
    tools: z.array(z.string()).max(20).default([]),
    maxLevel: z.enum(LEVELS).default("read"),
    useAi: z.boolean().default(false),
    modelTier: z.enum(["fast", "balanced", "advanced"]).default("fast"),
    maxToolCalls: z.number().int().min(0).max(20).default(6),
    maxTokens: z.number().int().min(256).max(8000).default(2000),
    maxTurns: z.number().int().min(1).max(8).default(4),
    schedule: z.union([z.object({ type: z.literal("interval"), minutes: z.number() }), z.object({ type: z.literal("daily"), time: z.string(), tz: z.string().optional() }), z.null()]).default(null),
    /** Deterministic steps that run first, without AI. */
    collectors: z.array(z.enum(["open_tasks_summary", "budget_summary"])).default([]),
    notifyResult: z.boolean().default(true),
  })
  .strict();
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export interface Agent {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  config: AgentConfig;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

type Row = { id: string; name: string; description: string; enabled: number; config: string; created_by: string; created_at: string; updated_at: string };
const toAgent = (r: Row): Agent => ({ id: r.id, name: r.name, description: r.description, enabled: !!r.enabled, config: AgentConfigSchema.parse(JSON.parse(r.config)), createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });

export const listAgents = (db: DB) => (db.prepare("SELECT * FROM agents ORDER BY created_at").all() as Row[]).map(toAgent);
export function getAgent(db: DB, id: string): Agent | null {
  const r = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
  return r ? toAgent(r) : null;
}

function validate(db: DB, c: AgentConfig) {
  const space = requireSpace(db, c.spaceId);
  if (space.confidential && c.useAi) throw new UserFacingError("Agents in a confidential space can't use AI.", 403, "confidential_space");
  if (c.maxLevel === "prohibited") throw new UserFacingError("An agent can't be given prohibited permissions.", 400, "invalid");
  for (const name of c.tools) {
    const t = getTool(name);
    if (!t) throw new UserFacingError(`Unknown tool: ${name}.`, 400, "invalid");
    if (levelRank(t.level) > levelRank(c.maxLevel)) throw new UserFacingError(`The tool ${name} needs the "${t.level}" level, above this agent's "${c.maxLevel}".`, 400, "invalid");
    if (!t.spaces.includes(c.spaceId)) throw new UserFacingError(`The tool ${name} doesn't work in the ${space.name} space.`, 400, "invalid");
  }
  if (c.useAi && c.maxToolCalls === 0 && c.tools.length) throw new UserFacingError("Give the agent at least one tool call, or remove its tools.", 400, "invalid");
}

/** True when `next` allows anything `prev` didn't. */
export function widens(prev: AgentConfig, next: AgentConfig) {
  return (
    next.spaceId !== prev.spaceId ||
    levelRank(next.maxLevel) > levelRank(prev.maxLevel) ||
    next.tools.some((t) => !prev.tools.includes(t)) ||
    (next.useAi && !prev.useAi) ||
    next.maxToolCalls > prev.maxToolCalls
  );
}

const jobId = (agentId: string) => `agentjob_${agentId}`;

function syncJob(db: DB, a: Agent) {
  if (a.config.schedule) {
    upsertJob(db, { id: jobId(a.id), kind: "agent.run", name: `Agent: ${a.name}`, schedule: a.config.schedule as Schedule, payload: { agentId: a.id }, enabled: a.enabled, catchUp: "skip", maxAttempts: 2 });
  } else if (db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId(a.id))) {
    setJobEnabled(db, jobId(a.id), false);
  }
}

export function createAgent(db: DB, input: { name: string; description?: string; config: unknown }, by: "user" | "ai" | "system" = "user"): Agent {
  const config = AgentConfigSchema.parse(input.config);
  validate(db, config);
  const id = newId("agent");
  const now = clockIso();
  db.prepare("INSERT INTO agents (id, name, description, enabled, config, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)").run(
    id,
    input.name.trim().slice(0, 60) || "Agent",
    (input.description ?? "").slice(0, 300),
    JSON.stringify(config),
    by,
    now,
    now,
  );
  logActivity(db, by === "user" ? "user" : "system", "agent.created", id, { level: config.maxLevel, count: config.tools.length }, config.spaceId);
  const a = getAgent(db, id)!;
  syncJob(db, a);
  return a;
}

export function updateAgent(db: DB, id: string, patch: { name?: string; description?: string; config?: unknown }, by: "user" | "ai" | "system" = "user"): Agent {
  const a = getAgent(db, id);
  if (!a) throw new UserFacingError("That agent wasn't found.", 404, "not_found");
  const config = patch.config === undefined ? a.config : AgentConfigSchema.parse(patch.config);
  validate(db, config);
  if (by !== "user" && widens(a.config, config)) throw new UserFacingError("Only you can give an agent more permissions.", 403, "not_user");
  db.prepare("UPDATE agents SET name = ?, description = ?, config = ?, enabled = CASE WHEN ? = 'user' THEN enabled ELSE 0 END, updated_at = ? WHERE id = ?").run(
    patch.name?.trim().slice(0, 60) || a.name,
    patch.description?.slice(0, 300) ?? a.description,
    JSON.stringify(config),
    by,
    clockIso(),
    id,
  );
  logActivity(db, by === "user" ? "user" : "system", "agent.updated", id, { level: config.maxLevel }, config.spaceId);
  const next = getAgent(db, id)!;
  syncJob(db, next);
  return next;
}

/** Only the user turns agents on. */
export function setAgentEnabled(db: DB, id: string, enabled: boolean) {
  const a = getAgent(db, id);
  if (!a) throw new UserFacingError("That agent wasn't found.", 404, "not_found");
  if (enabled) validate(db, a.config);
  db.prepare("UPDATE agents SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, clockIso(), id);
  logActivity(db, "user", enabled ? "agent.enabled" : "agent.disabled", id, {}, a.config.spaceId);
  syncJob(db, getAgent(db, id)!);
}

export function deleteAgent(db: DB, id: string) {
  const a = getAgent(db, id);
  if (!a) return;
  db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId(id));
  logActivity(db, "user", "agent.deleted", id, {}, a.config.spaceId);
}

/** A ready-made example, created switched off: a code-only daily check that uses no AI and costs nothing. */
export function ensureExampleAgent(db: DB) {
  if (db.prepare("SELECT 1 FROM agents LIMIT 1").get()) return;
  createAgent(
    db,
    {
      name: "Morning check (example)",
      description: "Code only, no AI: each morning, counts open tasks and AI spend and sends one quiet summary. Off until you turn it on.",
      config: { spaceId: "personal", tools: [], maxLevel: "read", useAi: false, collectors: ["open_tasks_summary", "budget_summary"], schedule: { type: "daily", time: "07:30" }, notifyResult: true },
    },
    "system",
  );
}
