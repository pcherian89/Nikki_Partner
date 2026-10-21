import { z } from "zod";
import type { Receipt, Task, TaskPriority } from "../shared/types.js";
import { createTask, currentPlan, DB, getSetting, getTask, listTasks, newId, setSetting, updateTask } from "./db.js";
import { UserFacingError } from "./errors.js";
import { removeTaskFromPlan, rescheduleTask } from "./planOps.js";
import { finishTask, reportSession, startTimer, stopTimer, type Viewer } from "./timer.js";
import { addDays, isValidDate, isValidTime, localNow } from "./time.js";
import { findDuplicate } from "./validate.js";

/**
 * The one set of task actions. HTTP routes (buttons) and Nikki's chat both call these, so they share validation.
 * Anything that would add, move or remove a scheduled block is NOT done here — it becomes a preview instead.
 */

export interface CommandCtx {
  tz: string;
  viewer: Viewer;
}

export type TaskFieldPatch = Partial<
  Pick<Task, "title" | "notes" | "estimateMinutes" | "deadline" | "deadlineTime" | "plannedDate" | "priority" | "optional" | "status" | "project" | "type">
>;

export function hasBlocks(db: DB, taskId: string, date: string): boolean {
  const plan = currentPlan(db, date);
  return !!plan?.blocks.some((b) => b.taskId === taskId);
}

/** Changes a task's own fields and keeps plans in step. Used by PATCH /api/tasks/:id and by chat. */
export function setTaskFields(db: DB, id: string, body: TaskFieldPatch, ctx: CommandCtx): Task {
  const cur = getTask(db, id);
  if (!cur) throw new UserFacingError("Task not found.", 404, "not_found");
  return db.transaction(() => {
    let patch = body;
    if (body.status === "done" && cur.status !== "done") {
      finishTask(db, id, { viewer: ctx.viewer });
      const { status: _s, ...rest } = body;
      patch = rest;
    }
    if (patch.deadline === null) patch = { ...patch, deadlineTime: null };
    const t = updateTask(db, id, patch);
    if (!t) throw new UserFacingError("Task not found.", 404, "not_found");
    if (body.plannedDate !== undefined) {
      const now = localNow(ctx.tz);
      for (const d of [now.date, addDays(now.date, 1)]) {
        if (d === body.plannedDate) continue;
        const why = body.plannedDate ? `Moved to ${body.plannedDate}.` : "Moved to someday.";
        removeTaskFromPlan(db, d, id, why, d === now.date ? { nowMin: now.minutes, note: why.replace(/\.$/, "") } : undefined);
      }
    }
    return t;
  })();
}

// ---------- chat actions ----------

export const ActionRequest = z.object({
  type: z.enum(["start", "pause", "finish", "report_time", "set_priority", "set_optional", "set_deadline", "move_day", "reopen"]),
  task_id: z.string(),
  minutes: z.number().int().min(0).max(1440).optional().default(0),
  from: z.string().optional().default(""),
  to: z.string().optional().default(""),
  date: z.string().optional().default(""),
  time: z.string().optional().default(""),
  priority: z.enum(["high", "normal", "low", ""]).optional().default(""),
  flag: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  switch_mode: z.enum(["pause", "finish", ""]).optional().default(""),
});
export type ActionRequest = z.infer<typeof ActionRequest>;

const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 37)}…` : s);
const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);
const clock = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

// ---------- undo ----------

type UndoRecord =
  | { kind: "restore"; taskId: string; patch: Partial<Task> }
  | { kind: "delete"; taskIds: string[] };

function saveUndo(db: DB, rec: UndoRecord): string {
  const id = newId("u");
  setSetting(db, `undo:${id}`, JSON.stringify({ rec, at: Date.now() }));
  return id;
}

export function undoAction(db: DB, undoId: string, ctx: CommandCtx): string {
  const raw = getSetting(db, `undo:${undoId}`);
  if (!raw) throw new UserFacingError("That can't be undone any more.", 404, "not_found");
  const { rec } = JSON.parse(raw) as { rec: UndoRecord };
  db.prepare("DELETE FROM settings WHERE key = ?").run(`undo:${undoId}`);
  if (rec.kind === "delete") {
    const now = localNow(ctx.tz);
    for (const id of rec.taskIds) {
      if (getTask(db, id)?.timerStartedAt) stopTimer(db, id, { viewer: ctx.viewer });
      db.prepare("UPDATE tasks SET deleted = 1 WHERE id = ?").run(id);
      for (const d of [now.date, addDays(now.date, 1)]) removeTaskFromPlan(db, d, id, "Undone.");
    }
    return rec.taskIds.length === 1 ? "Removed." : `Removed ${rec.taskIds.length} tasks.`;
  }
  const cur = getTask(db, rec.taskId);
  if (!cur) throw new UserFacingError("That task no longer exists.", 404, "not_found");
  updateTask(db, rec.taskId, rec.patch);
  return "Undone.";
}

export function recordCreated(db: DB, ids: string[]): string | undefined {
  return ids.length ? saveUndo(db, { kind: "delete", taskIds: ids }) : undefined;
}

const PRIORITY_WORD: Record<TaskPriority, string> = { high: "High", normal: "Normal", low: "Low" };

/** Runs one action and returns its receipt. Never throws: a refusal is a receipt with ok=false. */
export function runAction(db: DB, a: ActionRequest, ctx: CommandCtx): Receipt {
  const task = getTask(db, a.task_id);
  if (!task) return { ok: false, text: "That task wasn't found." };
  const label = `“${clip(task.title)}”`;
  const now = localNow(ctx.tz);
  try {
    switch (a.type) {
      case "start": {
        if (task.status === "done") return { ok: false, text: `${label} is already done.`, taskId: task.id };
        if (task.timerStartedAt) return { ok: true, text: `Already running: ${label}.`, taskId: task.id };
        startTimer(db, task.id, { switchMode: a.switch_mode || undefined, clientId: ctx.viewer.clientId, viewer: ctx.viewer });
        return { ok: true, text: `Started ${label}.`, taskId: task.id };
      }
      case "pause": {
        if (!task.timerStartedAt) return { ok: false, text: `${label} isn't running.`, taskId: task.id };
        const { session } = stopTimer(db, task.id, { viewer: ctx.viewer });
        return { ok: true, text: session && session.verified ? `Paused ${label} · ${hm(session.minutes)} recorded.` : `Paused ${label}.`, taskId: task.id };
      }
      case "finish": {
        if (task.status === "done") return { ok: false, text: `${label} is already done.`, taskId: task.id };
        const undoId = saveUndo(db, { kind: "restore", taskId: task.id, patch: { status: task.status, completedAt: null } });
        setTaskFields(db, task.id, { status: "done" }, ctx);
        const after = getTask(db, task.id)!;
        return { ok: true, text: `Finished ${label}${after.spentMinutes ? ` · ${hm(after.spentMinutes)} recorded` : " · no time recorded"}.`, taskId: task.id, undoId };
      }
      case "reopen": {
        const undoId = saveUndo(db, { kind: "restore", taskId: task.id, patch: { status: task.status, completedAt: task.completedAt } });
        setTaskFields(db, task.id, { status: "open" }, ctx);
        return { ok: true, text: `Reopened ${label}.`, taskId: task.id, undoId };
      }
      case "report_time": {
        const date = isValidDate(a.date) ? a.date : now.date;
        if (a.from && !isValidTime(a.from)) return { ok: false, text: "I didn't understand that start time.", taskId: task.id };
        if (a.to && !isValidTime(a.to)) return { ok: false, text: "I didn't understand that end time.", taskId: task.id };
        try {
          const s = reportSession(db, { taskId: task.id, date, minutes: a.minutes || null, from: a.from || null, to: a.to || null, force: a.force });
          return { ok: true, text: `Recorded ${hm(s.minutes)} on ${label} (reported).`, taskId: task.id };
        } catch (e) {
          if (e instanceof UserFacingError && e.code === "session_conflict") {
            return { ok: false, text: `Not recorded: ${e.message}`, taskId: task.id, retry: { ...a, force: true }, retryLabel: "Record anyway" };
          }
          throw e;
        }
      }
      case "set_priority": {
        if (!a.priority) return { ok: false, text: "Which priority: High, Normal or Low?", taskId: task.id };
        if (task.priority === a.priority) return { ok: true, text: `${label} is already ${PRIORITY_WORD[a.priority]}.`, taskId: task.id };
        const undoId = saveUndo(db, { kind: "restore", taskId: task.id, patch: { priority: task.priority } });
        setTaskFields(db, task.id, { priority: a.priority }, ctx);
        return { ok: true, text: `${label} is now ${PRIORITY_WORD[a.priority]} priority.`, taskId: task.id, undoId };
      }
      case "set_optional": {
        const undoId = saveUndo(db, { kind: "restore", taskId: task.id, patch: { optional: task.optional } });
        setTaskFields(db, task.id, { optional: a.flag }, ctx);
        return { ok: true, text: a.flag ? `${label} marked “if time allows”.` : `${label} is no longer “if time allows”.`, taskId: task.id, undoId };
      }
      case "set_deadline": {
        if (!a.date) {
          const undoId = saveUndo(db, { kind: "restore", taskId: task.id, patch: { deadline: task.deadline, deadlineTime: task.deadlineTime } });
          setTaskFields(db, task.id, { deadline: null }, ctx);
          return { ok: true, text: `Removed the deadline from ${label}.`, taskId: task.id, undoId };
        }
        if (!isValidDate(a.date)) return { ok: false, text: "I didn't understand that date.", taskId: task.id };
        if (a.time && !isValidTime(a.time)) return { ok: false, text: "I didn't understand that time.", taskId: task.id };
        if (a.date < now.date || (a.date === now.date && a.time && a.time <= now.time)) {
          return { ok: false, text: `That time has already passed. Did you mean ${a.date === now.date ? "tomorrow" : "a later date"}?`, taskId: task.id };
        }
        const undoId = saveUndo(db, { kind: "restore", taskId: task.id, patch: { deadline: task.deadline, deadlineTime: task.deadlineTime } });
        setTaskFields(db, task.id, { deadline: a.date, deadlineTime: a.time || null }, ctx);
        return { ok: true, text: `Deadline for ${label}: ${a.date === now.date ? "today" : a.date}${a.time ? ` at ${clock(a.time)}` : ""}.`, taskId: task.id, undoId };
      }
      case "move_day": {
        const target = a.date === "someday" ? null : a.date;
        if (target !== null && !isValidDate(target)) return { ok: false, text: "I didn't understand that date.", taskId: task.id };
        if (target !== null && target < now.date) return { ok: false, text: "That day has already passed.", taskId: task.id };
        // A task with scheduled blocks on today/tomorrow is a schedule change: needs a preview, not a silent move.
        const blocked = [now.date, addDays(now.date, 1)].filter((d) => d !== target && hasBlocks(db, task.id, d));
        if (blocked.length) {
          return { ok: false, text: `${label} has scheduled time that would change. Use Move… to review it.`, taskId: task.id, needsPreview: true };
        }
        const undoId = saveUndo(db, { kind: "restore", taskId: task.id, patch: { plannedDate: task.plannedDate } });
        setTaskFields(db, task.id, { plannedDate: target }, ctx);
        return { ok: true, text: `${label} → ${target === null ? "Someday" : target === now.date ? "Today" : target === addDays(now.date, 1) ? "Tomorrow" : target}.`, taskId: task.id, undoId };
      }
    }
  } catch (e) {
    if (e instanceof UserFacingError) {
      return { ok: false, text: `Not done: ${e.message}`, taskId: task.id, ...(e.code === "timer_running" ? { needsChoice: "switch" as const } : {}) };
    }
    throw e;
  }
}

export function runActions(db: DB, actions: ActionRequest[], ctx: CommandCtx): Receipt[] {
  return actions.slice(0, 20).map((a) => runAction(db, a, ctx));
}

/** Creates tasks from the same fields the Add-task buttons use. De-duplicates by title. */
export function addTasks(
  db: DB,
  items: { title: string; plannedDate?: string | null; priority?: TaskPriority; deadline?: string | null; deadlineTime?: string | null; optional?: boolean }[],
  source: Task["source"],
): { created: Task[]; skipped: string[] } {
  const created: Task[] = [];
  const skipped: string[] = [];
  const existing = listTasks(db);
  for (const it of items) {
    const title = it.title.trim();
    if (!title) continue;
    if (findDuplicate(title, [...existing, ...created])) {
      skipped.push(title);
      continue;
    }
    created.push(createTask(db, { ...it, title, source }));
  }
  return { created, skipped };
}

export { rescheduleTask };
