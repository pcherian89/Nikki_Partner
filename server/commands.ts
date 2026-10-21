import { z } from "zod";
import type { ProjectStatus, Receipt, Task, TaskPriority } from "../shared/types.js";
import { createTask, currentPlan, DB, getSetting, getTask, listTasks, newId, setSetting, updateTask } from "./db.js";
import { UserFacingError } from "./errors.js";
import { removeTaskFromPlan, rescheduleTask } from "./planOps.js";
import { finishTask, reportSession, startTimer, stopTimer, type Viewer } from "./timer.js";
import { addDays, isValidDate, isValidTime, localNow } from "./time.js";
import { findDuplicate } from "./validate.js";
import { getProject, linkTask, setMilestoneStatus, setProjectStatus } from "./projects.js";
import { cancelReminder, completeReminder, createReminder, dropAnchoredForTask, editReminder, reanchorForTask, snoozeReminder, type ReminderTime } from "./reminders.js";

/**
 * The one set of task actions. HTTP routes (buttons) and Nikki's chat both call these, so they share validation.
 * Anything that would add, move or remove a scheduled block is NOT done here — it becomes a preview instead.
 */

export interface CommandCtx {
  tz: string;
  viewer: Viewer;
}

export type TaskFieldPatch = Partial<
  Pick<Task, "title" | "notes" | "estimateMinutes" | "deadline" | "deadlineTime" | "plannedDate" | "priority" | "optional" | "status" | "project" | "type" | "projectId" | "milestoneId">
>;

export function hasBlocks(db: DB, taskId: string, date: string): boolean {
  const plan = currentPlan(db, date);
  return !!plan?.blocks.some((b) => b.taskId === taskId);
}

/** Changes a task's own fields and keeps plans in step. Used by PATCH /api/tasks/:id and by chat. */
export function setTaskFields(db: DB, id: string, body: TaskFieldPatch, ctx: CommandCtx): Task {
  const cur = getTask(db, id);
  if (!cur) throw new UserFacingError("Task not found.", 404, "not_found");
  // The same rules for a button and for chat: nothing is set in the past.
  const now0 = localNow(ctx.tz);
  if (body.deadline && body.deadline !== cur.deadline) {
    const t = body.deadlineTime ?? null;
    if (body.deadline < now0.date) throw new UserFacingError("That deadline is in the past.", 400, "invalid");
    if (body.deadline === now0.date && t && t <= now0.time) {
      throw new UserFacingError("That time has already passed today. Did you mean tomorrow?", 400, "invalid");
    }
  }
  if (body.plannedDate && body.plannedDate !== cur.plannedDate && body.plannedDate < now0.date) {
    throw new UserFacingError("That day has already passed.", 400, "invalid");
  }
  return db.transaction(() => {
    let patch = body;
    if (body.status === "done" && cur.status !== "done") {
      finishTask(db, id, { viewer: ctx.viewer });
      const { status: _s, ...rest } = body;
      patch = rest;
    }
    if (patch.deadline === null) patch = { ...patch, deadlineTime: null };
    // Linking to a project goes through the same checks as the chat action.
    const newProject = patch.projectId !== undefined ? patch.projectId : cur.projectId;
    const newMilestone = patch.projectId === null ? null : patch.milestoneId !== undefined ? patch.milestoneId : cur.milestoneId;
    if (patch.projectId !== undefined || patch.milestoneId !== undefined) {
      if (newProject !== cur.projectId || newMilestone !== cur.milestoneId) linkTask(db, id, newProject, newMilestone);
      const { projectId: _p, milestoneId: _m, project: _l, ...rest } = patch;
      patch = patch.project !== undefined && newProject === cur.projectId && !newProject ? { ...rest, project: patch.project } : rest;
    }
    const t = updateTask(db, id, patch);
    if (!t) throw new UserFacingError("Task not found.", 404, "not_found");
    // Reminders that count down to this task's deadline follow it (or go if it is done).
    if (body.status === "done" && cur.status !== "done") dropAnchoredForTask(db, id);
    else if (patch.deadline !== undefined || patch.deadlineTime !== undefined) reanchorForTask(db, id, ctx.tz);
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
  type: z.enum(["start", "pause", "finish", "report_time", "set_priority", "set_optional", "set_deadline", "move_day", "reopen", "create_reminder", "edit_reminder", "complete_reminder", "cancel_reminder", "snooze_reminder", "pause_project", "resume_project", "complete_project", "archive_project", "complete_milestone", "reopen_milestone", "link_task"]),
  task_id: z.string().optional().default(""),
  reminder_id: z.string().optional().default(""),
  project_id: z.string().optional().default(""),
  milestone_id: z.string().optional().default(""),
  title: z.string().optional().default(""),
  /** create_reminder: count from the task's deadline (whole days / minutes before). */
  offset_days: z.number().int().min(0).max(365).optional().default(0),
  offset_minutes: z.number().int().min(0).max(525600).optional().default(0),
  from_deadline: z.boolean().optional().default(false),
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
  | { kind: "cancel_reminder"; id: string }
  | { kind: "project_status"; id: string; status: ProjectStatus }
  | { kind: "milestone_status"; id: string; status: "open" | "done" }
  | { kind: "link"; taskId: string; projectId: string | null; milestoneId: string | null }
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
  if (rec.kind === "project_status") {
    setProjectStatus(db, rec.id, rec.status);
    return "Undone.";
  }
  if (rec.kind === "milestone_status") {
    setMilestoneStatus(db, rec.id, rec.status);
    return "Undone.";
  }
  if (rec.kind === "link") {
    linkTask(db, rec.taskId, rec.projectId, rec.milestoneId);
    return "Undone.";
  }
  if (rec.kind === "cancel_reminder") {
    cancelReminder(db, rec.id, ctx.tz);
    return "Reminder removed.";
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
const fmtWhen = (r: { localDate: string; localTime: string }, today: string, tomorrow: string) =>
  `${r.localDate === today ? "today" : r.localDate === tomorrow ? "tomorrow" : r.localDate} at ${clock(r.localTime)}`;

function runReminderAction(db: DB, a: ActionRequest, ctx: CommandCtx): Receipt {
  const now = localNow(ctx.tz);
  const tomorrow = addDays(now.date, 1);
  const label = (t: string) => `“${clip(t)}”`;
  try {
    switch (a.type) {
      case "create_reminder": {
        if (!a.title.trim()) return { ok: false, text: "What should the reminder say?" };
        const when: ReminderTime =
          a.from_deadline && (a.task_id || a.project_id)
            ? { anchor: { kind: a.task_id ? ("task_deadline" as const) : ("project_target" as const), id: a.task_id || a.project_id, offsetMinutes: a.offset_minutes || a.offset_days * 1440, atTime: a.time || null } }
            : { date: a.date || now.date, time: a.time || null };
        if (!a.from_deadline && !a.date) return { ok: false, text: "Which day should I remind you?" };
        const { reminder, created } = createReminder(db, { title: a.title, taskId: a.task_id || null, projectId: a.project_id || null, when, source: "nikki" }, ctx.tz);
        if (!created) return { ok: true, text: `You already have that reminder: ${label(reminder.title)} ${fmtWhen(reminder, now.date, tomorrow)}.` };
        return { ok: true, text: `Reminder set: ${label(reminder.title)} ${fmtWhen(reminder, now.date, tomorrow)}.`, undoId: saveUndo(db, { kind: "cancel_reminder", id: reminder.id }) };
      }
      case "edit_reminder": {
        const r = editReminder(db, a.reminder_id, { title: a.title || undefined, when: a.date ? { date: a.date, time: a.time || null } : undefined }, ctx.tz);
        return { ok: true, text: `Updated: ${label(r.title)} ${fmtWhen(r, now.date, tomorrow)}.` };
      }
      case "complete_reminder": {
        const r = completeReminder(db, a.reminder_id, ctx.tz);
        return { ok: true, text: `Done: ${label(r.title)}.` };
      }
      case "cancel_reminder": {
        const r = cancelReminder(db, a.reminder_id, ctx.tz);
        return { ok: true, text: `Cancelled the reminder ${label(r.title)}.` };
      }
      default: {
        const r = snoozeReminder(db, a.reminder_id, a.minutes || 60, ctx.tz);
        return { ok: true, text: `Snoozed: ${label(r.title)} → ${fmtWhen(r, now.date, tomorrow)}.` };
      }
    }
  } catch (e) {
    if (e instanceof UserFacingError) return { ok: false, text: `Not done: ${e.message}` };
    throw e;
  }
}

function runProjectAction(db: DB, a: ActionRequest): Receipt {
  const clipT = (t: string) => `“${clip(t)}”`;
  try {
    if (a.type === "link_task") {
      const task = getTask(db, a.task_id);
      if (!task) return { ok: false, text: "That task wasn't found." };
      const before = { projectId: task.projectId, milestoneId: task.milestoneId };
      if (!a.project_id) {
        linkTask(db, task.id, null, null);
        return { ok: true, text: `Took ${clipT(task.title)} out of its project.`, taskId: task.id, undoId: saveUndo(db, { kind: "link", taskId: task.id, ...before }) };
      }
      const p = linkTask(db, task.id, a.project_id, a.milestone_id || null);
      return { ok: true, text: `Linked ${clipT(task.title)} to ${clipT(p.project ?? "the project")}.`, taskId: task.id, undoId: saveUndo(db, { kind: "link", taskId: task.id, ...before }) };
    }
    if (a.type === "complete_milestone" || a.type === "reopen_milestone") {
      const row = db.prepare("SELECT status, title FROM milestones WHERE id = ?").get(a.milestone_id) as { status: "open" | "done"; title: string } | undefined;
      if (!row) return { ok: false, text: "That milestone wasn't found." };
      const next = a.type === "complete_milestone" ? "done" : "open";
      if (row.status === next) return { ok: true, text: `${clipT(row.title)} is already ${next === "done" ? "done" : "open"}.` };
      const undoId = saveUndo(db, { kind: "milestone_status", id: a.milestone_id, status: row.status });
      setMilestoneStatus(db, a.milestone_id, next);
      return { ok: true, text: next === "done" ? `Milestone done: ${clipT(row.title)}.` : `Reopened ${clipT(row.title)}.`, undoId };
    }
    const p = getProject(db, a.project_id);
    if (!p) return { ok: false, text: "That project wasn't found." };
    const status: ProjectStatus = a.type === "pause_project" ? "paused" : a.type === "resume_project" ? "active" : a.type === "complete_project" ? "completed" : "archived";
    if (p.status === status) return { ok: true, text: `${clipT(p.title)} is already ${status}.` };
    const undoId = saveUndo(db, { kind: "project_status", id: p.id, status: p.status });
    setProjectStatus(db, p.id, status);
    const verb = { paused: "Paused", active: "Resumed", completed: "Marked complete:", archived: "Archived" }[status];
    return { ok: true, text: `${verb} ${clipT(p.title)}.`, undoId };
  } catch (e) {
    if (e instanceof UserFacingError) return { ok: false, text: `Not done: ${e.message}` };
    throw e;
  }
}

export function runAction(db: DB, a: ActionRequest, ctx: CommandCtx): Receipt {
  if (a.type.endsWith("_reminder")) return runReminderAction(db, a, ctx);
  if (a.type.endsWith("_project") || a.type.endsWith("_milestone") || a.type === "link_task") return runProjectAction(db, a);
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
        const undoId = saveUndo(db, { kind: "restore", taskId: task.id, patch: { deadline: task.deadline, deadlineTime: task.deadlineTime } });
        setTaskFields(db, task.id, { deadline: a.date, deadlineTime: a.time || null }, ctx);
        return { ok: true, text: `Deadline for ${label}: ${a.date === now.date ? "today" : a.date}${a.time ? ` at ${clock(a.time)}` : ""}.`, taskId: task.id, undoId };
      }
      case "move_day": {
        const target = a.date === "someday" ? null : a.date;
        if (target !== null && !isValidDate(target)) return { ok: false, text: "I didn't understand that date.", taskId: task.id };
        // A task with scheduled blocks on today/tomorrow is a schedule change: needs a preview, not a silent move.
        const blocked = [now.date, addDays(now.date, 1)].filter((d) => d !== target && hasBlocks(db, task.id, d));
        if (blocked.length) {
          return { ok: false, text: `${label} has scheduled time that would change. Use Move… to review it.`, taskId: task.id, needsPreview: true };
        }
        const undoId = saveUndo(db, { kind: "restore", taskId: task.id, patch: { plannedDate: task.plannedDate } });
        setTaskFields(db, task.id, { plannedDate: target }, ctx);
        return { ok: true, text: `${label} → ${target === null ? "Someday" : target === now.date ? "Today" : target === addDays(now.date, 1) ? "Tomorrow" : target}.`, taskId: task.id, undoId };
      }
      default:
        return { ok: false, text: "I can't do that yet." };
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
