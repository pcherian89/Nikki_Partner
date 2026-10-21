import type { DaySummary, NextSuggestion, Plan, Task, TaskMeta } from "../shared/types.js";
import { currentPlan, DB, latestPlanBefore, listMeetings, listMeetingsBetween, wrapUpFor } from "./db.js";
import { addDays, localNow, toMinutes } from "./time.js";
import { freeMinutes, WORK_KINDS } from "./validate.js";

/** Used when a day has no plan and the profile has no usual hours. */
export const DEFAULT_WINDOW = { start: "09:00", end: "17:00" };

const fmt12 = (hhmm: string) => {
  const h = Number(hhmm.slice(0, 2));
  return `${h % 12 || 12}:${hhmm.slice(3)} ${h < 12 ? "AM" : "PM"}`;
};

export interface Facts {
  today: string;
  now: string; // HH:MM
  nowMin: number;
  tz: string;
  windowFor: (date: string) => { start: string; end: string };
  meetingsFor: (date: string) => { start: string; end: string }[];
  planFor: (date: string) => Plan | null;
}

export function buildFacts(db: DB, tz: string, profile: { workStart: string; workEnd: string }): Facts {
  const n = localNow(tz);
  const usual = /^\d{2}:\d{2}$/.test(profile.workStart) && /^\d{2}:\d{2}$/.test(profile.workEnd) && toMinutes(profile.workEnd) > toMinutes(profile.workStart) ? { start: profile.workStart, end: profile.workEnd } : DEFAULT_WINDOW;
  const plans = new Map<string, Plan | null>();
  const planFor = (date: string) => {
    if (!plans.has(date)) plans.set(date, currentPlan(db, date));
    return plans.get(date)!;
  };
  const meetings = new Map<string, { start: string; end: string }[]>();
  const upcoming = listMeetingsBetween(db, n.date, addDays(n.date, 8));
  for (const m of [...listMeetings(db, n.date), ...upcoming]) {
    const list = meetings.get(m.date) ?? [];
    if (!list.some((x) => (x as any).id === m.id)) list.push({ ...m } as any);
    meetings.set(m.date, list);
  }
  return {
    today: n.date,
    now: n.time,
    nowMin: n.minutes,
    tz,
    windowFor: (date) => planFor(date)?.window ?? usual,
    meetingsFor: (date) => meetings.get(date) ?? [],
    planFor,
  };
}

/** Free working time between two points, after meetings. Handles deadlines today and tomorrow. */
function availableBetween(f: Facts, toDate: string, toTime: string | null): number {
  let total = 0;
  for (let d = f.today; d <= toDate; d = addDays(d, 1)) {
    const w = f.windowFor(d);
    const start = d === f.today ? Math.max(f.nowMin, toMinutes(w.start)) : toMinutes(w.start);
    const end = d === toDate && toTime ? Math.min(toMinutes(w.end), toMinutes(toTime)) : toMinutes(w.end);
    if (end <= start) continue;
    total += freeMinutes({ start: pad(start), end: pad(end) }, f.meetingsFor(d) as any);
    if (d > addDays(f.today, 3)) break; // deadlines further out aren't assessed
  }
  return total;
}

const pad = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Deadline moment as minutes since the start of `today` (can exceed 1440 for tomorrow). */
function deadlineKey(f: Facts, t: Task): number {
  const dayOffset = t.deadline === f.today ? 0 : t.deadline === addDays(f.today, 1) ? 1440 : t.deadline! < f.today ? -1440 : 99 * 1440;
  const time = t.deadlineTime ?? (t.deadline! >= f.today && dayOffset < 99 * 1440 ? f.windowFor(t.deadline!).end : "23:59");
  return dayOffset + toMinutes(time);
}

export function remainingEffort(t: Task): number | null {
  return t.estimateMinutes != null ? Math.max(0, t.estimateMinutes - t.spentMinutes) : null;
}

/**
 * Remaining effort, recorded time and deadline status for every open task. Deadlines due today or tomorrow are checked
 * together, earliest first, so competing work is counted: "at risk" means the work due by then doesn't fit.
 * A task with no estimate is never called at risk — the app can't tell — and no estimate is ever invented.
 */
export function computeTaskMeta(tasks: Task[], f: Facts, sessionCounts: Map<string, number>): Record<string, TaskMeta> {
  const meta: Record<string, TaskMeta> = {};
  for (const t of tasks) {
    meta[t.id] = {
      remainingMinutes: remainingEffort(t),
      workedMinutes: t.spentMinutes,
      sessionCount: sessionCounts.get(t.id) ?? 0,
      deadlineStatus: null,
      shortByMinutes: null,
    };
  }
  const due = tasks.filter((t) => t.type === "action" && t.status !== "done" && t.deadline);
  for (const t of due) {
    const key = deadlineKey(f, t);
    meta[t.id].deadlineStatus = key < f.nowMin || t.deadline! < f.today ? "overdue" : "ok";
  }
  const soon = due
    .filter((t) => meta[t.id].deadlineStatus === "ok" && t.deadline! <= addDays(f.today, 1))
    .sort((a, b) => deadlineKey(f, a) - deadlineKey(f, b));
  let cumulative = 0;
  for (const t of soon) {
    const remaining = remainingEffort(t);
    if (remaining == null) {
      meta[t.id].deadlineStatus = "no_estimate";
      continue;
    }
    cumulative += remaining;
    const available = availableBetween(f, t.deadline!, t.deadlineTime);
    if (cumulative > available) {
      meta[t.id].deadlineStatus = "at_risk";
      meta[t.id].shortByMinutes = cumulative - available;
    }
  }
  for (const t of due) {
    if (meta[t.id].deadlineStatus === "ok" && remainingEffort(t) == null) meta[t.id].deadlineStatus = "no_estimate";
  }
  return meta;
}

/** Open tasks on a day's list: assigned to it, or placed in its plan. */
export function dayList(tasks: Task[], plan: Plan | null, date: string): Task[] {
  const planned = new Set((plan?.blocks ?? []).filter((b) => WORK_KINDS.has(b.kind) && b.taskId).map((b) => b.taskId!));
  return tasks.filter((t) => t.type === "action" && (t.plannedDate === date || planned.has(t.id)));
}

export function computeDays(tasks: Task[], f: Facts): DaySummary[] {
  const out: DaySummary[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(f.today, i);
    const plan = f.planFor(date);
    const all = dayList(tasks, plan, date);
    const open = all.filter((t) => t.status !== "done");
    const w = f.windowFor(date);
    const from = i === 0 ? Math.max(f.nowMin, toMinutes(w.start)) : toMinutes(w.start);
    const toMin = toMinutes(w.end);
    const meetings = f.meetingsFor(date) as any;
    const span = toMin > from ? { start: pad(from), end: pad(toMin) } : null;
    const scheduled = (plan?.blocks ?? [])
      .filter((b) => WORK_KINDS.has(b.kind) && (i > 0 || toMinutes(b.end) > f.nowMin))
      .reduce((s, b) => s + toMinutes(b.end) - Math.max(toMinutes(b.start), i === 0 ? f.nowMin : 0), 0);
    const known = open.map((t) => remainingEffort(t)).filter((m): m is number => m != null);
    out.push({
      date,
      openIds: open.map((t) => t.id),
      doneCount: all.length - open.length,
      remainingMinutes: known.reduce((s, m) => s + m, 0),
      unknownEstimates: open.length - known.length,
      scheduledMinutes: Math.max(0, scheduled),
      availableMinutes: span ? freeMinutes(span, meetings) : 0,
      fixedMinutes: span ? Math.max(0, toMin - from - freeMinutes(span, meetings)) : 0,
    });
  }
  return out;
}

/** Unfinished work from earlier days that nobody has decided about yet. */
export function computeCarryovers(db: DB, tasks: Task[], f: Facts): string[] {
  const ids = new Set<string>();
  for (const t of tasks) if (t.type === "action" && t.status !== "done" && t.plannedDate && t.plannedDate < f.today) ids.add(t.id);
  const last = latestPlanBefore(db, f.today);
  if (last && !wrapUpFor(db, last.date)) {
    const inLast = new Set(last.blocks.filter((b) => WORK_KINDS.has(b.kind) && b.taskId).map((b) => b.taskId!));
    for (const t of tasks) if (inLast.has(t.id) && t.status !== "done" && t.type === "action" && !t.plannedDate) ids.add(t.id);
  }
  const todays = new Set(dayList(tasks, f.planFor(f.today), f.today).map((t) => t.id));
  return [...ids].filter((id) => !todays.has(id));
}

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const;

/**
 * "What should I work on next?" — one ranking used by the screens and by Nikki: deadline trouble first, then (if the
 * user marked it) "if time allows" last, then priority, then the time it is scheduled.
 */
export function suggestNext(tasks: Task[], f: Facts, meta: Record<string, TaskMeta>): NextSuggestion | null {
  const plan = f.planFor(f.today);
  const candidates = dayList(tasks, plan, f.today).filter((t) => t.status === "open" && !t.timerStartedAt);
  if (!candidates.length) return null;
  const scheduledAt = (t: Task) => {
    const b = (plan?.blocks ?? []).find((x) => x.taskId === t.id && WORK_KINDS.has(x.kind) && toMinutes(x.end) > f.nowMin);
    return b ? toMinutes(b.start) : null;
  };
  const risk = (t: Task) => {
    const s = meta[t.id]?.deadlineStatus;
    return s === "overdue" ? 0 : s === "at_risk" ? 1 : t.deadline === f.today ? 2 : 3;
  };
  const sorted = [...candidates].sort(
    (a, b) =>
      risk(a) - risk(b) ||
      Number(a.optional) - Number(b.optional) ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      (scheduledAt(a) ?? 9999) - (scheduledAt(b) ?? 9999) ||
      a.createdAt.localeCompare(b.createdAt),
  );
  const t = sorted[0];
  const s = meta[t.id]?.deadlineStatus;
  const when = scheduledAt(t);
  const reason =
    s === "overdue"
      ? "Its deadline has passed"
      : s === "at_risk"
        ? `At risk: due ${t.deadlineTime ? fmt12(t.deadlineTime) : "today"}${meta[t.id].shortByMinutes ? `, about ${meta[t.id].shortByMinutes} min more than you have` : ""}`
        : t.deadline === f.today
          ? `Due ${t.deadlineTime ? fmt12(t.deadlineTime) : "today"}`
          : t.priority === "high"
            ? "High priority"
            : when != null
              ? `Scheduled for ${fmt12(pad(when))}`
              : "Next on your list";
  return { taskId: t.id, reason };
}

export function deadlinesThisWeek(tasks: Task[], f: Facts, meta: Record<string, TaskMeta>) {
  const end = addDays(f.today, 6);
  return tasks
    .filter((t) => t.status !== "done" && t.deadline && t.deadline <= end)
    .sort((a, b) => a.deadline!.localeCompare(b.deadline!) || (a.deadlineTime ?? "99").localeCompare(b.deadlineTime ?? "99"))
    .map((t) => ({ taskId: t.id, title: t.title, date: t.deadline!, time: t.deadlineTime, status: meta[t.id]?.deadlineStatus ?? null }));
}
