import type { Task } from "../shared/types.js";
import {
  adjustSpent,
  clockIso,
  currentPlan,
  DB,
  deleteSession,
  elapsedMinutes,
  getSession,
  getSetting,
  getTask,
  insertSession,
  listSessions,
  listTasks,
  recordTimerSession,
  sessionTimezone,
  setSetting,
  type SessionRow,
  updateSession,
  updateTask,
  NEEDS_CHECK,
} from "./db.js";
import { UserFacingError } from "./errors.js";
import { currentInstant, localNow, localToUtc, toMinutes } from "./time.js";
import { assessTimer, SNOOZE_MINUTES, type TimerDoubt, type TimerFacts } from "./timerRules.js";

/** Who is asking: lets the server tell "started on another device" and "away for hours" apart from a normal refresh. */
export interface Viewer {
  clientId: string | null;
  prevSeenAt: string | null;
}

const fmt = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`);

export function runningTasks(db: DB): Task[] {
  return listTasks(db).filter((t) => t.timerStartedAt);
}

/** What the server knows about a running timer, including whether its elapsed time can be trusted. */
export function describeTimer(db: DB, task: Task, viewer: Viewer = { clientId: null, prevSeenAt: null }) {
  const now = currentInstant();
  const tz = sessionTimezone(db);
  const today = localNow(tz, now).date;
  const plan = currentPlan(db, today);
  const startedBy = getSetting(db, `timer_client:${task.id}`) || null;
  const doubt = assessTimer({
    startedAt: task.timerStartedAt!,
    now,
    estimateMinutes: task.estimateMinutes,
    tz,
    startedBy,
    thisClient: viewer.clientId,
    thisClientPrevSeen: viewer.prevSeenAt,
    snoozeUntil: getSetting(db, `timer_snooze:${task.id}`),
    windowEnd: plan?.window.end ?? null,
  });
  return {
    taskId: task.id,
    title: task.title,
    startedAt: task.timerStartedAt!,
    minutes: elapsedMinutes(task.timerStartedAt!),
    doubt,
    otherDevice: doubt === "other_device",
  };
}

function conflict(running: Task) {
  return new UserFacingError(
    `“${running.title}” is already running (${fmt(elapsedMinutes(running.timerStartedAt!))}). Pause it or finish it first.`,
    409,
    "timer_running",
    undefined,
    { runningTaskId: running.id, title: running.title, minutes: elapsedMinutes(running.timerStartedAt!) },
  );
}

export type Resolution = { keep?: boolean; minutes?: number | null; discard?: boolean };

/** Ends a timer. Uncertain time is saved as "needs a check" unless the caller says how long it really was. */
export function stopTimer(db: DB, taskId: string, opts: { resolution?: Resolution; viewer?: Viewer } = {}): { task: Task; session: SessionRow | null } {
  const task = getTask(db, taskId);
  if (!task) throw new UserFacingError("Task not found.", 404, "not_found");
  if (!task.timerStartedAt) return { task, session: null };
  return db.transaction(() => {
    const r = opts.resolution;
    const info = describeTimer(db, task, opts.viewer);
    let session: SessionRow | null = null;
    if (r?.discard) {
      session = null;
    } else if (r?.minutes != null) {
      const minutes = Math.max(1, Math.round(r.minutes));
      const note = minutes === info.minutes ? null : `Corrected from ${fmt(info.minutes)}`;
      session = recordTimerSession(db, task, { verified: true, minutes, note, doubt: null });
    } else if (r?.keep) {
      session = recordTimerSession(db, task, { verified: true, doubt: null });
    } else {
      session = recordTimerSession(db, task, { doubt: info.doubt });
    }
    if (session?.verified) adjustSpent(db, taskId, session.minutes);
    updateTask(db, taskId, { timerStartedAt: null });
    return { task: getTask(db, taskId)!, session };
  })();
}

/** Starts the timer. Never silently stops another one: the caller chooses to pause it or finish it. */
export function startTimer(db: DB, taskId: string, opts: { switchMode?: "pause" | "finish"; clientId?: string | null; viewer?: Viewer } = {}) {
  const task = getTask(db, taskId);
  if (!task) throw new UserFacingError("Task not found.", 404, "not_found");
  if (task.status === "done") throw new UserFacingError("That task is already done. Reopen it to work on it again.", 409, "task_done");
  return db.transaction(() => {
    const others = runningTasks(db).filter((t) => t.id !== taskId);
    if (others.length && !opts.switchMode) throw conflict(others[0]);
    let paused: { taskId: string; title: string; session: SessionRow | null } | null = null;
    for (const o of others) {
      const stopped = stopTimer(db, o.id, { viewer: opts.viewer });
      if (opts.switchMode === "finish") updateTask(db, o.id, { status: "done" });
      paused = { taskId: o.id, title: o.title, session: stopped.session };
    }
    if (!task.timerStartedAt) {
      updateTask(db, taskId, { timerStartedAt: clockIso() });
      setSetting(db, `timer_client:${taskId}`, opts.clientId ?? "");
      db.prepare("DELETE FROM settings WHERE key = ?").run(`timer_snooze:${taskId}`);
    }
    return { task: getTask(db, taskId)!, paused };
  })();
}

/** "Still working": this device takes the timer and isn't asked again for a while. */
export function confirmStillWorking(db: DB, taskId: string, clientId: string | null) {
  const task = getTask(db, taskId);
  if (!task?.timerStartedAt) throw new UserFacingError("That timer isn't running.", 409, "not_running");
  setSetting(db, `timer_client:${taskId}`, clientId ?? "");
  setSetting(db, `timer_snooze:${taskId}`, new Date(currentInstant().getTime() + SNOOZE_MINUTES * 60000).toISOString());
  return getTask(db, taskId)!;
}

/** Finishing a task ends its timer but never invents time: with no timer, nothing is recorded. */
export function finishTask(db: DB, taskId: string, opts: { resolution?: Resolution; viewer?: Viewer } = {}) {
  return db.transaction(() => {
    const stopped = stopTimer(db, taskId, opts);
    const task = updateTask(db, taskId, { status: "done" });
    return { task: task!, session: stopped.session };
  })();
}

/** Confirm or correct uncertain timer time (or discard it). */
export function resolveSession(db: DB, sessionId: string, r: Resolution): SessionRow | null {
  const s = getSession(db, sessionId);
  if (!s) throw new UserFacingError("That time record wasn't found.", 404, "not_found");
  if (r.discard) {
    deleteSession(db, sessionId);
    return null;
  }
  if (r.minutes != null) {
    const minutes = Math.max(1, Math.round(r.minutes));
    return updateSession(db, sessionId, { minutes, verified: true, note: minutes === s.minutes ? null : `Corrected from ${fmt(s.minutes)}` });
  }
  return updateSession(db, sessionId, { verified: true, note: null });
}

// ---------- time reported after the fact ----------

export interface ReportInput {
  taskId: string;
  date: string;
  minutes?: number | null;
  from?: string | null;
  to?: string | null;
  note?: string | null;
  /** The user has seen the conflict warning and wants it recorded anyway. */
  force?: boolean;
}

/**
 * Records time the user says they worked (they forgot the timer). It is labelled "reported" — never mixed up with
 * measured time — and checked against other recorded time so the same hour isn't counted twice.
 */
export function reportSession(db: DB, input: ReportInput): SessionRow {
  const task = getTask(db, input.taskId);
  if (!task) throw new UserFacingError("Task not found.", 404, "not_found");
  const tz = sessionTimezone(db);
  const today = localNow(tz).date;
  if (input.date > today) throw new UserFacingError("You can only record time for today or an earlier day.", 400, "invalid");
  let minutes = input.minutes ?? null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let fromMin: number | null = null;
  let toMin: number | null = null;
  if (input.from || input.to) {
    if (!input.from || !input.to) throw new UserFacingError("Give both a start and an end time, or just how many minutes.", 400, "invalid");
    fromMin = toMinutes(input.from);
    toMin = toMinutes(input.to);
    if (toMin <= fromMin) throw new UserFacingError("The end time must be after the start time.", 400, "invalid");
    minutes = toMin - fromMin;
    startedAt = localToUtc(input.date, input.from, tz).toISOString();
    endedAt = localToUtc(input.date, input.to, tz).toISOString();
    if (input.date === today && new Date(endedAt).getTime() > currentInstant().getTime() + 60000) {
      throw new UserFacingError("That end time hasn't happened yet.", 400, "invalid");
    }
  }
  if (!minutes || minutes < 1 || minutes > 24 * 60) throw new UserFacingError("Give how long you worked (1 minute to 24 hours).", 400, "invalid");

  if (!input.force) {
    const others = listSessions(db, input.date);
    const names = new Map(listTasks(db).map((t) => [t.id, t.title]));
    if (fromMin != null && toMin != null) {
      for (const s of others) {
        if (!s.startedAt || !s.endedAt) continue;
        const a = localNow(tz, new Date(s.startedAt));
        const b = localNow(tz, new Date(s.endedAt));
        if (a.date !== input.date || b.date !== input.date) continue;
        if (a.minutes < toMin && fromMin < b.minutes) {
          const same = s.taskId === input.taskId && a.minutes === fromMin && b.minutes === toMin;
          throw new UserFacingError(
            same
              ? "You've already recorded this exact time."
              : `That overlaps ${s.source === "timer" ? "timer" : "reported"} time on “${names.get(s.taskId) ?? "another task"}” (${a.time}–${b.time}).`,
            409,
            "session_conflict",
            undefined,
            { kind: same ? "duplicate" : "overlap", with: { taskId: s.taskId, title: names.get(s.taskId) ?? "", from: a.time, to: b.time, minutes: s.minutes } },
          );
        }
      }
    } else {
      const recent = others.find((s) => s.taskId === input.taskId && s.source === "reported" && s.minutes === minutes && !s.startedAt);
      if (recent) {
        throw new UserFacingError(`You already recorded ${fmt(minutes)} on this task today.`, 409, "session_conflict", undefined, {
          kind: "duplicate",
          with: { taskId: recent.taskId, title: names.get(recent.taskId) ?? "", minutes: recent.minutes },
        });
      }
    }
  }
  return insertSession(db, { taskId: input.taskId, date: input.date, minutes, source: "reported", startedAt, endedAt, note: input.note ?? null });
}

export { NEEDS_CHECK };
export type { TimerDoubt, TimerFacts };
