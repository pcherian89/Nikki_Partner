import { createHash } from "node:crypto";
import { z } from "zod";
import { clockIso, createTask, newId, type DB } from "../db.js";
import { UserFacingError } from "../errors.js";
import { createReminder } from "../reminders.js";
import { currentInstant } from "../time.js";
import { logActivity } from "./activity.js";
import { controls } from "./controls.js";
import { notify, notifyTz } from "./notifications.js";
import { levelRank, requireSpace, type Level } from "./spaces.js";

/**
 * Actions: anything Nikki or an agent wants to DO, as a record that goes through approval and safe execution.
 *
 * - The approval is bound to the exact parameters: the server hashes a canonical form of them, the approval stores
 *   that hash, and execution recomputes it. Editing an action clears its approval.
 * - Approvals expire. A consequential approval lasts one hour by default; an action scheduled later than that
 *   needs a fresh confirmation when its time comes (it goes back to "pending" and the user is notified).
 * - Each action has a unique idempotency key, so the same request can't create two actions. Execution is claimed
 *   with a conditional update, so one action can't run twice at once. This does NOT make an external effect
 *   impossible to repeat: if the outcome of an external call is unknown (timeout, crash mid-call), the action is
 *   marked "uncertain" and is never retried automatically; the user checks and resolves it.
 * - Every check is in code here, not in an AI prompt: emergency stop, space enabled, level not prohibited,
 *   approval present, matching and unexpired.
 */

export type ActionStatus = "pending" | "approved" | "scheduled" | "executing" | "succeeded" | "failed" | "uncertain" | "rejected" | "expired" | "cancelled";

export interface ActionHandler<P = Record<string, unknown>> {
  kind: string;
  level: Level;
  /** True when the effect happens outside Nikki's own database (email, calendar…). Unknown outcomes become "uncertain". */
  external: boolean;
  /** Human-readable label for approval screens. */
  label: string;
  /** What the item is, in a word, for the inbox card ("Reminder", "Task", "Email"). */
  noun?: string;
  /** The approve button's wording: the action itself ("Add reminder", "Send email"), never a generic "Approve". */
  approveLabel?: string;
  /** One plain sentence on what approving really does (and what it does NOT do), shown on the card. */
  consequence?: string;
  schema: z.ZodType<P>;
  execute: (db: DB, params: P, ctx: { actionId: string; idempotencyKey: string; spaceId: string }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Optional: ask the provider whether an interrupted external action actually happened. */
  reconcile?: (db: DB, action: Action) => Promise<"succeeded" | "failed" | "unknown">;
}

/** Thrown by a handler when the provider confirmed the action did not happen (safe to mark failed). */
export class DefiniteFailure extends Error {}

const handlers = new Map<string, ActionHandler<any>>();
export function registerActionHandler<P>(h: ActionHandler<P>) {
  handlers.set(h.kind, h as ActionHandler<any>);
}
export const actionHandler = (kind: string) => handlers.get(kind);
export const actionKinds = () => [...handlers.values()].map((h) => ({ kind: h.kind, level: h.level, external: h.external, label: h.label, noun: h.noun ?? h.label, approveLabel: h.approveLabel ?? "Approve", consequence: h.consequence ?? "" }));

export interface Action {
  id: string;
  kind: string;
  title: string;
  spaceId: string;
  agentId: string | null;
  level: Level;
  params: Record<string, unknown>;
  paramsHash: string;
  status: ActionStatus;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  approvedAt: string | null;
  approvalValidUntil: string | null;
  executeAfter: string | null;
  attempts: number;
  result: Record<string, unknown> | null;
  error: string | null;
  /** Why it was proposed (from the agent; shown as the agent's words, never followed as instructions). */
  reason: string | null;
  /** "Later": hidden from the to-review list and the badge until this time. */
  snoozedUntil: string | null;
}

type Row = {
  id: string;
  kind: string;
  title: string;
  space_id: string;
  agent_id: string | null;
  level: Level;
  params: string;
  params_hash: string;
  status: ActionStatus;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  approved_at: string | null;
  approved_hash: string | null;
  approval_valid_until: string | null;
  approved_by_session: string | null;
  execute_after: string | null;
  attempts: number;
  result: string | null;
  error: string | null;
  reason: string | null;
  snoozed_until: string | null;
};
const toAction = (r: Row): Action => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  spaceId: r.space_id,
  agentId: r.agent_id,
  level: r.level,
  params: JSON.parse(r.params),
  paramsHash: r.params_hash,
  status: r.status,
  idempotencyKey: r.idempotency_key,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at,
  approvedAt: r.approved_at,
  approvalValidUntil: r.approval_valid_until,
  executeAfter: r.execute_after,
  attempts: r.attempts,
  result: r.result ? JSON.parse(r.result) : null,
  error: r.error,
  reason: r.reason ?? null,
  snoozedUntil: r.snoozed_until ?? null,
});

/** Canonical JSON (sorted keys) so the same parameters always hash the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
export const hashParams = (kind: string, spaceId: string, params: unknown, executeAfter: string | null) =>
  createHash("sha256").update(canonical({ kind, spaceId, params, executeAfter })).digest("hex");

const PROPOSAL_TTL_H = 72;
const APPROVAL_TTL_MIN: Record<Level, number> = { read: 24 * 60, prepare: 24 * 60, change: 24 * 60, consequential: 60, prohibited: 0 };

export function getAction(db: DB, id: string): Action | null {
  const r = db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Row | undefined;
  return r ? toAction(r) : null;
}

export function listActions(db: DB, opts: { status?: ActionStatus[]; limit?: number } = {}): Action[] {
  expireStale(db);
  const rows = opts.status?.length
    ? (db.prepare(`SELECT * FROM actions WHERE status IN (${opts.status.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT ?`).all(...opts.status, opts.limit ?? 50) as Row[])
    : (db.prepare("SELECT * FROM actions ORDER BY created_at DESC LIMIT ?").all(opts.limit ?? 50) as Row[]);
  return rows.map(toAction);
}

function expireStale(db: DB) {
  const now = clockIso();
  db.prepare("UPDATE actions SET status = 'expired', updated_at = ? WHERE status IN ('pending', 'approved') AND expires_at < ?").run(now, now);
}

export interface ProposeInput {
  kind: string;
  title: string;
  spaceId: string;
  params: Record<string, unknown>;
  agentId?: string | null;
  idempotencyKey?: string;
  executeAfter?: string | null;
  /** Why it is proposed, in one or two sentences. Stored as text and shown as such. */
  reason?: string | null;
}

/** Creates an action awaiting approval. Same idempotency key → the existing action is returned, never a duplicate. */
export function proposeAction(db: DB, input: ProposeInput, actor: "user" | `agent:${string}` = "user"): Action {
  const h = handlers.get(input.kind);
  if (!h) throw new UserFacingError("Nikki doesn't know how to do that action.", 400, "unknown_action");
  if (h.level === "prohibited") throw new UserFacingError("That action is not allowed.", 403, "prohibited");
  requireSpace(db, input.spaceId);
  const parsed = h.schema.safeParse(input.params);
  if (!parsed.success) throw new UserFacingError("The action's details are not valid.", 400, "invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const key = input.idempotencyKey ?? newId("idem");
  const existing = db.prepare("SELECT * FROM actions WHERE idempotency_key = ?").get(key) as Row | undefined;
  if (existing) return toAction(existing);
  const executeAfter = input.executeAfter ? new Date(input.executeAfter).toISOString() : null;
  const id = newId("act");
  const now = clockIso();
  const hash = hashParams(input.kind, input.spaceId, parsed.data, executeAfter);
  const expires = new Date(currentInstant().getTime() + PROPOSAL_TTL_H * 3600_000).toISOString();
  db.prepare(
    "INSERT INTO actions (id, kind, title, space_id, agent_id, level, params, params_hash, status, idempotency_key, created_at, updated_at, expires_at, execute_after, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
  ).run(id, input.kind, input.title.slice(0, 160), input.spaceId, input.agentId ?? null, h.level, JSON.stringify(parsed.data), hash, key, now, now, expires, executeAfter, input.reason?.trim().slice(0, 400) || null);
  logActivity(db, actor, "action.proposed", id, { kind: input.kind, level: h.level }, input.spaceId);
  return getAction(db, id)!;
}

export function editAction(db: DB, id: string, params: Record<string, unknown>, executeAfter?: string | null): Action {
  const a = mustGet(db, id);
  if (!["pending", "approved", "scheduled"].includes(a.status)) throw new UserFacingError("This action can no longer be changed.", 409, "not_editable");
  const h = handlers.get(a.kind)!;
  const parsed = h.schema.safeParse(params);
  if (!parsed.success) throw new UserFacingError("The action's details are not valid.", 400, "invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const after = executeAfter === undefined ? a.executeAfter : executeAfter ? new Date(executeAfter).toISOString() : null;
  const hash = hashParams(a.kind, a.spaceId, parsed.data, after);
  // Any edit clears the approval: the user must approve what will actually run.
  db.prepare(
    "UPDATE actions SET params = ?, params_hash = ?, execute_after = ?, status = 'pending', approved_at = NULL, approved_hash = NULL, approval_valid_until = NULL, approved_by_session = NULL, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(parsed.data), hash, after, clockIso(), id);
  logActivity(db, "user", "action.edited", id, {}, a.spaceId);
  return getAction(db, id)!;
}

/**
 * Approves exactly what the user saw: `shownHash` must equal the current parameters' hash, so an approval can never
 * apply to parameters that changed after the screen was drawn.
 */
export function approveAction(db: DB, id: string, shownHash: string, sessionId: string | null): Action {
  expireStale(db);
  const a = mustGet(db, id);
  // While everything is stopped, nothing new is approved: an approval given now would only go stale before resume.
  if (controls(db).actionsPaused) throw new UserFacingError("Nikki's agents and actions are stopped. Resume them in Context → Agent controls first.", 423, "actions_paused");
  if (a.status !== "pending") throw new UserFacingError(`This action is ${a.status}, so it can't be approved.`, 409, "not_pending");
  if (shownHash !== a.paramsHash) throw new UserFacingError("This action changed after you looked at it. Review it again.", 409, "stale_approval");
  const now = currentInstant();
  const validUntil = new Date(now.getTime() + APPROVAL_TTL_MIN[a.level] * 60_000).toISOString();
  const status: ActionStatus = a.executeAfter && new Date(a.executeAfter).getTime() > now.getTime() ? "scheduled" : "approved";
  db.prepare("UPDATE actions SET status = ?, approved_at = ?, approved_hash = ?, approval_valid_until = ?, approved_by_session = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(
    status,
    now.toISOString(),
    a.paramsHash,
    validUntil,
    sessionId,
    now.toISOString(),
    id,
  );
  logActivity(db, "user", "action.approved", id, { kind: a.kind, level: a.level, session: sessionId }, a.spaceId);
  return getAction(db, id)!;
}

/** "Later": keeps the proposal but hides it from the to-review list and the badge until `until`. Approval is unchanged (none). */
export function snoozeAction(db: DB, id: string, until: string) {
  const a = mustGet(db, id);
  if (a.status !== "pending") throw new UserFacingError("Only items waiting for you can be put off.", 409, "not_pending");
  const t = new Date(until);
  if (Number.isNaN(t.getTime()) || t.getTime() <= currentInstant().getTime()) throw new UserFacingError("Pick a later time.", 400, "invalid");
  // Never past the proposal's own expiry: it would expire unseen.
  const capped = new Date(Math.min(t.getTime(), new Date(a.expiresAt).getTime() - 60 * 60_000)).toISOString();
  db.prepare("UPDATE actions SET snoozed_until = ?, updated_at = ? WHERE id = ?").run(capped, clockIso(), id);
  logActivity(db, "user", "action.snoozed", id, {}, a.spaceId);
  return getAction(db, id)!;
}

/** Waiting for the user right now: pending (not put off) or uncertain. Used for the badge and the "To review" count. */
export function waitingCount(db: DB) {
  expireStale(db);
  const now = clockIso();
  return (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE (status = 'pending' AND (snoozed_until IS NULL OR snoozed_until <= ?)) OR status = 'uncertain'").get(now) as { n: number }).n;
}

/**
 * After the emergency stop is lifted: anything that was approved and is now due goes back to "pending" and the user
 * is asked again. Nothing approved before or during the stop runs by itself on resume. Actions scheduled for the
 * future stay scheduled (and still face the normal approval-expiry check when their time comes).
 */
export async function requeueAfterResume(db: DB) {
  const now = clockIso();
  const rows = db.prepare("SELECT id, title, space_id FROM actions WHERE status IN ('approved', 'scheduled') AND (execute_after IS NULL OR execute_after <= ?)").all(now) as { id: string; title: string; space_id: string }[];
  for (const r of rows) {
    db.prepare("UPDATE actions SET status = 'pending', approved_at = NULL, approved_hash = NULL, approval_valid_until = NULL, approved_by_session = NULL, updated_at = ? WHERE id = ?").run(now, r.id);
    logActivity(db, "system", "action.requeued_after_stop", r.id, {}, r.space_id);
  }
  if (rows.length) {
    await notify(db, { category: "approval", priority: "normal", title: "Please confirm again", body: `${rows.length} approved item${rows.length === 1 ? " was" : "s were"} waiting while Nikki was stopped. Nothing ran; check ${rows.length === 1 ? "it" : "them"} again in the inbox.`, link: "/?view=inbox" });
  }
  return rows.length;
}

export function rejectAction(db: DB, id: string) {
  const a = mustGet(db, id);
  if (!["pending", "approved", "scheduled"].includes(a.status)) throw new UserFacingError("This action can no longer be rejected.", 409, "not_pending");
  db.prepare("UPDATE actions SET status = 'rejected', updated_at = ? WHERE id = ?").run(clockIso(), id);
  logActivity(db, "user", "action.rejected", id, {}, a.spaceId);
}

export function cancelAction(db: DB, id: string) {
  const a = mustGet(db, id);
  if (!["pending", "approved", "scheduled"].includes(a.status)) throw new UserFacingError("This action can no longer be cancelled.", 409, "not_cancellable");
  db.prepare("UPDATE actions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(clockIso(), id);
  logActivity(db, "user", "action.cancelled", id, {}, a.spaceId);
}

/** For uncertain actions: the user checked the provider and says what really happened. Never re-runs anything. */
export function resolveUncertain(db: DB, id: string, outcome: "succeeded" | "failed") {
  const a = mustGet(db, id);
  if (a.status !== "uncertain") throw new UserFacingError("Only uncertain actions can be resolved this way.", 409, "not_uncertain");
  db.prepare("UPDATE actions SET status = ?, updated_at = ?, error = CASE WHEN ? = 'failed' THEN 'Marked as not done by you.' ELSE error END WHERE id = ?").run(outcome, clockIso(), outcome, id);
  logActivity(db, "user", "action.resolved", id, { result: outcome }, a.spaceId);
}

function mustGet(db: DB, id: string) {
  const a = getAction(db, id);
  if (!a) throw new UserFacingError("That action wasn't found.", 404, "not_found");
  return a;
}

/** Executes an approved action once. Every gate is checked here, at execution time. */
export async function executeAction(db: DB, id: string): Promise<Action> {
  expireStale(db);
  const a = mustGet(db, id);
  const h = handlers.get(a.kind);
  const now = currentInstant();
  if (controls(db).actionsPaused) throw new UserFacingError("All actions are paused (emergency stop). Resume them in Context → Safety.", 423, "actions_paused");
  if (!h || h.level === "prohibited" || levelRank(a.level) !== levelRank(h.level)) throw new UserFacingError("That action is not allowed.", 403, "prohibited");
  if (a.status === "scheduled" && a.executeAfter && new Date(a.executeAfter).getTime() > now.getTime()) throw new UserFacingError("This action is scheduled for later.", 409, "not_due");
  if (a.status !== "approved" && a.status !== "scheduled") throw new UserFacingError(`This action is ${a.status}, so it won't run.`, 409, "not_approved");
  const row = db.prepare("SELECT approved_hash, approval_valid_until FROM actions WHERE id = ?").get(id) as { approved_hash: string | null; approval_valid_until: string | null };
  if (!row.approved_hash || row.approved_hash !== hashParams(a.kind, a.spaceId, a.params, a.executeAfter) || row.approved_hash !== a.paramsHash) {
    throw new UserFacingError("The approval doesn't match this action's details. Review it again.", 409, "approval_mismatch");
  }
  if (!row.approval_valid_until || new Date(row.approval_valid_until).getTime() < now.getTime()) {
    // An approval given earlier is not assumed to hold now: back to pending, and the user is asked again.
    db.prepare("UPDATE actions SET status = 'pending', approved_at = NULL, approved_hash = NULL, approval_valid_until = NULL, updated_at = ? WHERE id = ?").run(clockIso(), id);
    logActivity(db, "system", "action.approval_expired", id, {}, a.spaceId);
    await notify(db, { category: "approval", priority: "high", title: "Please confirm again", body: `"${a.title}" is due, but your approval has expired.`, sensitive: true, link: `/?view=inbox&action=${id}`, dedupeKey: `reconfirm:${id}:${a.updatedAt}` });
    throw new UserFacingError("Your approval has expired. Nikki asked you to confirm again.", 409, "approval_expired");
  }
  requireSpace(db, a.spaceId);
  // Claim: only one caller can move it to executing.
  const claimed = db.prepare("UPDATE actions SET status = 'executing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('approved', 'scheduled')").run(clockIso(), id).changes;
  if (!claimed) throw new UserFacingError("This action is already running or finished.", 409, "already_running");
  logActivity(db, a.agentId ? `agent:${a.agentId}` : "user", "action.executing", id, { kind: a.kind }, a.spaceId);
  try {
    const result = await h.execute(db, a.params, { actionId: id, idempotencyKey: a.idempotencyKey, spaceId: a.spaceId });
    db.prepare("UPDATE actions SET status = 'succeeded', result = ?, error = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(result ?? {}), clockIso(), id);
    logActivity(db, "system", "action.succeeded", id, { kind: a.kind }, a.spaceId);
  } catch (e) {
    const msg = ((e as Error)?.message ?? String(e)).slice(0, 300);
    const status: ActionStatus = !h.external || e instanceof DefiniteFailure || e instanceof UserFacingError ? "failed" : "uncertain";
    db.prepare("UPDATE actions SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, msg, clockIso(), id);
    logActivity(db, "system", `action.${status}`, id, { kind: a.kind }, a.spaceId);
    if (status === "uncertain") {
      await notify(db, { category: "approval", priority: "high", title: "Check an action", body: `Nikki couldn't confirm whether "${a.title}" happened. It won't retry; please check and mark it.`, sensitive: true, link: `/?view=inbox&action=${id}` });
    }
  }
  return getAction(db, id)!;
}

/** On start: an action left "executing" by a stopped process is reconciled if possible, otherwise marked uncertain. */
export async function recoverActions(db: DB) {
  const stuck = (db.prepare("SELECT * FROM actions WHERE status = 'executing'").all() as Row[]).map(toAction);
  for (const a of stuck) {
    const h = handlers.get(a.kind);
    let outcome: "succeeded" | "failed" | "unknown" = "unknown";
    if (h?.reconcile) outcome = await h.reconcile(db, a).catch(() => "unknown" as const);
    else if (h && !h.external) outcome = "unknown"; // local effects are transactional, but we still never guess
    const status: ActionStatus = outcome === "unknown" ? "uncertain" : outcome;
    db.prepare("UPDATE actions SET status = ?, error = COALESCE(error, 'Interrupted while running.'), updated_at = ? WHERE id = ?").run(status, clockIso(), a.id);
    logActivity(db, "system", "action.recovered", a.id, { status }, a.spaceId);
    if (status === "uncertain") await notify(db, { category: "approval", priority: "high", title: "Check an action", body: `"${a.title}" was interrupted. Nikki won't retry it; please check and mark it.`, sensitive: true, link: `/?view=inbox&action=${a.id}` });
  }
  return stuck.length;
}

/** Job: run scheduled actions whose time has come (each still passes every gate in executeAction). */
export async function runScheduledActions(db: DB) {
  const due = db.prepare("SELECT id FROM actions WHERE status = 'scheduled' AND execute_after <= ?").all(clockIso()) as { id: string }[];
  for (const { id } of due) {
    try {
      await executeAction(db, id);
    } catch {
      /* gate refusals are recorded on the action / activity log */
    }
  }
  return due.length;
}

// ---------- Phase 0 handlers: Nikki-internal only. No handler reaches an external service. ----------

registerActionHandler({
  kind: "nikki.create_task",
  label: "Add a task to Nikki",
  noun: "Task",
  approveLabel: "Create task",
  consequence: "Adds this task to your list in Nikki. Nothing is sent to anyone.",
  level: "change",
  external: false,
  schema: z.object({ title: z.string().trim().min(1).max(300), estimateMinutes: z.number().int().min(5).max(600).optional() }).strict(),
  execute: (db, p) => {
    const t = createTask(db, { title: p.title, estimateMinutes: p.estimateMinutes ?? 30, source: "nikki" } as Parameters<typeof createTask>[1]);
    return { taskId: t.id };
  },
});

registerActionHandler({
  kind: "nikki.create_reminder",
  label: "Set a reminder in Nikki",
  noun: "Reminder",
  approveLabel: "Add reminder",
  consequence: "Nikki will remind you at this time. It only reminds you: nothing is paid, booked or sent.",
  level: "change",
  external: false,
  schema: z.object({ title: z.string().trim().min(1).max(300), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/) }).strict(),
  execute: (db, p) => {
    const r = createReminder(db, { title: p.title, when: { date: p.date, time: p.time }, source: "nikki" }, notifyTz(db));
    return { reminderId: r.reminder.id };
  },
});

registerActionHandler({
  kind: "nikki.notify",
  label: "Send you a notification",
  noun: "Note for you",
  approveLabel: "Show it",
  consequence: "Shows this note in your inbox. Nothing leaves Nikki.",
  level: "prepare",
  external: false,
  schema: z.object({ title: z.string().trim().min(1).max(140), body: z.string().max(600).default("") }).strict(),
  execute: async (db, p) => {
    const { item } = await notify(db, { category: "agent", title: p.title, body: p.body, sensitive: true });
    return { notificationId: item.id };
  },
});
