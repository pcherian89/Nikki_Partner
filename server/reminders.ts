import type { Reminder } from "../shared/types.js";
import { clockIso, DB, getTask, newId } from "./db.js";
import { getProject } from "./projects.js";
import { UserFacingError } from "./errors.js";
import { addDays, currentInstant, isValidDate, isValidTime, localNow, localToUtc } from "./time.js";

/**
 * Reminders: something to remember at a time. They never take work time and are not tasks, deadlines, scheduled blocks
 * or commitments. A reminder can be linked to a task, and its time can follow that task's deadline.
 *
 * Delivery is honest about what it is: when a reminder's time comes it becomes "due" and is shown in the app. A push
 * to closed apps is attempted only to devices that opted in, and recorded only when the push service accepted it.
 */

interface Row {
  id: string;
  title: string;
  task_id: string | null;
  project_id: string | null;
  remind_at: string;
  anchor: string | null;
  status: Reminder["status"];
  source: Reminder["source"];
  created_at: string;
  fired_at: string | null;
  done_at: string | null;
  channels: string;
}

export const DEFAULT_REMINDER_TIME = "09:00";

function toReminder(r: Row, tz: string): Reminder {
  const local = localNow(tz, new Date(r.remind_at));
  return {
    id: r.id,
    title: r.title,
    taskId: r.task_id,
    projectId: r.project_id,
    remindAt: r.remind_at,
    localDate: local.date,
    localTime: local.time,
    anchor: r.anchor ? JSON.parse(r.anchor) : null,
    status: r.status,
    source: r.source,
    createdAt: r.created_at,
    firedAt: r.fired_at,
    doneAt: r.done_at,
    channels: JSON.parse(r.channels) as string[],
  };
}

export function getReminder(db: DB, id: string, tz: string): Reminder | null {
  const r = db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as Row | undefined;
  return r ? toReminder(r, tz) : null;
}

/** Waiting and due reminders, soonest first. Finished ones are history, not clutter. */
export function activeReminders(db: DB, tz: string): Reminder[] {
  return (db.prepare("SELECT * FROM reminders WHERE status IN ('pending','due') ORDER BY remind_at, created_at").all() as Row[]).map((r) => toReminder(r, tz));
}

export type ReminderTime =
  | { date: string; time?: string | null }
  | { anchor: { kind: "task_deadline" | "project_target"; id: string; offsetMinutes?: number; offsetDays?: number; atTime?: string | null } };

export interface ReminderInput {
  title: string;
  taskId?: string | null;
  projectId?: string | null;
  when: ReminderTime;
  source?: Reminder["source"];
}

/** The moment a deadline-anchored reminder fires. */
function anchorInstant(db: DB, a: NonNullable<Reminder["anchor"]>, tz: string): Date {
  const task =
    a.kind === "task_deadline"
      ? getTask(db, a.id)
      : (() => {
          const p = getProject(db, a.id);
          return p && p.targetDate ? { deadline: p.targetDate, deadlineTime: null } : null;
        })();
  if (!task || !task.deadline) {
    throw new UserFacingError(a.kind === "task_deadline" ? "That task has no deadline to count from. Set a deadline first." : "That project has no target date to count from. Set one first.", 400, "no_deadline");
  }
  // Whole days before: same time of day (default 09:00) that many days earlier. Otherwise minutes before the deadline time.
  if (a.offsetMinutes % 1440 === 0 && !(a.atTime == null && task.deadlineTime && a.offsetMinutes === 0)) {
    const days = a.offsetMinutes / 1440;
    return localToUtc(addDays(task.deadline, -days), a.atTime ?? DEFAULT_REMINDER_TIME, tz);
  }
  const base = localToUtc(task.deadline, task.deadlineTime ?? "17:00", tz);
  return new Date(base.getTime() - a.offsetMinutes * 60000);
}

function resolveWhen(db: DB, when: ReminderTime, tz: string): { at: Date; anchor: Reminder["anchor"] } {
  if ("anchor" in when) {
    const a = when.anchor;
    const offsetMinutes = a.offsetMinutes ?? (a.offsetDays ?? 0) * 1440;
    if (offsetMinutes < 0) throw new UserFacingError("A reminder can't be after the deadline it follows.", 400, "invalid");
    const anchor = { kind: a.kind, id: a.id, offsetMinutes, atTime: a.atTime && isValidTime(a.atTime) ? a.atTime : null };
    return { at: anchorInstant(db, anchor, tz), anchor };
  }
  if (!isValidDate(when.date)) throw new UserFacingError("I didn't understand that date.", 400, "invalid");
  const time = when.time && isValidTime(when.time) ? when.time : DEFAULT_REMINDER_TIME;
  return { at: localToUtc(when.date, time, tz), anchor: null };
}

/** Creates a reminder. The same reminder (title and time) is never created twice. */
export function createReminder(db: DB, input: ReminderInput, tz: string): { reminder: Reminder; created: boolean } {
  const title = input.title.trim().slice(0, 300);
  if (!title) throw new UserFacingError("A reminder needs something to remember.", 400, "invalid");
  if (input.taskId && !getTask(db, input.taskId)) throw new UserFacingError("That task wasn't found.", 404, "not_found");
  const { at, anchor } = resolveWhen(db, input.when, tz);
  const now = currentInstant();
  if (at.getTime() < now.getTime() - 60_000) {
    const l = localNow(tz, at);
    throw new UserFacingError(`That time has already passed (${l.date} ${l.time}). Pick a time in the future.`, 400, "in_the_past");
  }
  const iso = at.toISOString();
  const dup = db.prepare("SELECT * FROM reminders WHERE status IN ('pending','due') AND lower(title) = lower(?) AND remind_at = ? AND IFNULL(task_id,'') = ?").get(title, iso, input.taskId ?? "") as Row | undefined;
  if (dup) return { reminder: toReminder(dup, tz), created: false };
  const id = newId("r");
  db.prepare(
    "INSERT INTO reminders (id, title, task_id, project_id, remind_at, anchor, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
  ).run(id, title, input.taskId ?? null, input.projectId ?? null, iso, anchor ? JSON.stringify(anchor) : null, input.source ?? "user", clockIso());
  return { reminder: getReminder(db, id, tz)!, created: true };
}

export interface ReminderEdit {
  title?: string;
  when?: { date: string; time?: string | null };
}

export function editReminder(db: DB, id: string, edit: ReminderEdit, tz: string): Reminder {
  const cur = getReminder(db, id, tz);
  if (!cur || (cur.status !== "pending" && cur.status !== "due")) throw new UserFacingError("That reminder isn't active.", 404, "not_found");
  const title = edit.title?.trim().slice(0, 300) || cur.title;
  let iso = cur.remindAt;
  let anchor = cur.anchor;
  let status: Reminder["status"] = cur.status;
  if (edit.when) {
    const { at } = resolveWhen(db, edit.when, tz);
    if (at.getTime() < currentInstant().getTime() - 60_000) throw new UserFacingError("That time has already passed. Pick a time in the future.", 400, "in_the_past");
    iso = at.toISOString();
    anchor = null; // a hand-set time no longer follows the deadline
    status = "pending";
  }
  db.prepare("UPDATE reminders SET title = ?, remind_at = ?, anchor = ?, status = ?, fired_at = CASE WHEN ? = 'pending' THEN NULL ELSE fired_at END WHERE id = ?").run(
    title,
    iso,
    anchor ? JSON.stringify(anchor) : null,
    status,
    status,
    id,
  );
  return getReminder(db, id, tz)!;
}

export function completeReminder(db: DB, id: string, tz: string): Reminder {
  const cur = getReminder(db, id, tz);
  if (!cur || (cur.status !== "pending" && cur.status !== "due")) throw new UserFacingError("That reminder isn't active.", 404, "not_found");
  db.prepare("UPDATE reminders SET status = 'done', done_at = ? WHERE id = ?").run(clockIso(), id);
  return getReminder(db, id, tz)!;
}

export function cancelReminder(db: DB, id: string, tz: string): Reminder {
  const cur = getReminder(db, id, tz);
  if (!cur || (cur.status !== "pending" && cur.status !== "due")) throw new UserFacingError("That reminder isn't active.", 404, "not_found");
  db.prepare("UPDATE reminders SET status = 'cancelled', done_at = ? WHERE id = ?").run(clockIso(), id);
  return getReminder(db, id, tz)!;
}

/** Pushes a reminder to a later time (default: an hour from now). It will fire again then. */
export function snoozeReminder(db: DB, id: string, minutes: number, tz: string): Reminder {
  const cur = getReminder(db, id, tz);
  if (!cur || (cur.status !== "pending" && cur.status !== "due")) throw new UserFacingError("That reminder isn't active.", 404, "not_found");
  const at = new Date(currentInstant().getTime() + Math.min(Math.max(minutes, 5), 7 * 1440) * 60000);
  db.prepare("UPDATE reminders SET status = 'pending', remind_at = ?, anchor = NULL, fired_at = NULL, channels = '[]' WHERE id = ?").run(at.toISOString(), id);
  return getReminder(db, id, tz)!;
}

/** A project's target date moved: reminders counting down to it follow. */
export function reanchorForProject(db: DB, projectId: string, tz: string) {
  const rows = db.prepare("SELECT id, anchor FROM reminders WHERE status IN ('pending','due') AND anchor IS NOT NULL").all() as { id: string; anchor: string }[];
  for (const r of rows) {
    const a = JSON.parse(r.anchor) as NonNullable<Reminder["anchor"]>;
    if (a.kind !== "project_target" || a.id !== projectId) continue;
    try {
      const at = anchorInstant(db, a, tz);
      if (at.getTime() < currentInstant().getTime() - 60_000) db.prepare("UPDATE reminders SET status = 'cancelled', done_at = ? WHERE id = ?").run(clockIso(), r.id);
      else db.prepare("UPDATE reminders SET remind_at = ?, status = 'pending', fired_at = NULL WHERE id = ?").run(at.toISOString(), r.id);
    } catch {
      db.prepare("UPDATE reminders SET status = 'cancelled', done_at = ? WHERE id = ?").run(clockIso(), r.id);
    }
  }
}

/** A task's deadline moved: deadline-anchored reminders follow it. If the new time is already past they are cancelled. */
export function reanchorForTask(db: DB, taskId: string, tz: string): string[] {
  const rows = db.prepare("SELECT * FROM reminders WHERE status IN ('pending','due') AND anchor IS NOT NULL").all() as Row[];
  const notes: string[] = [];
  for (const r of rows) {
    const a = JSON.parse(r.anchor!) as NonNullable<Reminder["anchor"]>;
    if (a.kind !== "task_deadline" || a.id !== taskId) continue;
    try {
      const at = anchorInstant(db, a, tz);
      if (at.getTime() < currentInstant().getTime() - 60_000) {
        db.prepare("UPDATE reminders SET status = 'cancelled', done_at = ? WHERE id = ?").run(clockIso(), r.id);
        notes.push(`Cancelled the reminder “${r.title}”: its new time had already passed.`);
      } else {
        db.prepare("UPDATE reminders SET remind_at = ?, status = 'pending', fired_at = NULL WHERE id = ?").run(at.toISOString(), r.id);
      }
    } catch {
      db.prepare("UPDATE reminders SET status = 'cancelled', done_at = ? WHERE id = ?").run(clockIso(), r.id);
      notes.push(`Cancelled the reminder “${r.title}”: the task no longer has a deadline.`);
    }
  }
  return notes;
}

/** A task was deleted or finished: reminders that only existed to count down to its deadline are no longer needed. */
export function dropAnchoredForTask(db: DB, taskId: string) {
  const rows = db.prepare("SELECT id, anchor FROM reminders WHERE status IN ('pending','due') AND anchor IS NOT NULL").all() as { id: string; anchor: string }[];
  for (const r of rows) if ((JSON.parse(r.anchor) as { id: string; kind: string }).id === taskId && (JSON.parse(r.anchor) as { kind: string }).kind === "task_deadline") db.prepare("UPDATE reminders SET status = 'cancelled', done_at = ? WHERE id = ?").run(clockIso(), r.id);
}

/** Linked reminders of a deleted task go with it (nothing should point at a task that isn't there). */
export function cancelForDeletedTask(db: DB, taskId: string) {
  db.prepare("UPDATE reminders SET status = 'cancelled', done_at = ? WHERE task_id = ? AND status IN ('pending','due')").run(clockIso(), taskId);
}

export type Deliver = (r: Reminder) => Promise<string[]>;

/**
 * Fires every reminder whose time has come. The status change is a compare-and-set, so even if two ticks (or two server
 * processes) run at once, a reminder is delivered by exactly one of them.
 */
export async function tickReminders(db: DB, tz: string, deliver?: Deliver): Promise<Reminder[]> {
  const now = currentInstant().toISOString();
  const due = db.prepare("SELECT id FROM reminders WHERE status = 'pending' AND remind_at <= ? ORDER BY remind_at").all(now) as { id: string }[];
  const fired: Reminder[] = [];
  for (const { id } of due) {
    const won = db.prepare("UPDATE reminders SET status = 'due', fired_at = ?, channels = '[\"in-app\"]' WHERE id = ? AND status = 'pending'").run(now, id).changes === 1;
    if (!won) continue;
    let r = getReminder(db, id, tz)!;
    if (deliver) {
      try {
        const sent = await deliver(r);
        if (sent.length) {
          db.prepare("UPDATE reminders SET channels = ? WHERE id = ?").run(JSON.stringify(["in-app", ...sent]), id);
          r = getReminder(db, id, tz)!;
        }
      } catch (e) {
        console.warn(`[reminders] delivery failed for ${id}: ${(e as Error).message}`);
      }
    }
    fired.push(r);
  }
  return fired;
}

/** For the model and the screens: reminders on a local date. */
export const remindersOn = (list: Reminder[], date: string) => list.filter((r) => r.localDate === date || (r.status === "due" && r.localDate <= date));

