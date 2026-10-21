import type { MemoryItem, MemoryKind, MemoryStatus, MemoryUpdate, Task, WeeklyFacts } from "../shared/types.js";
import { clockIso, DB, listMeetingsBetween, listSessions, newId } from "./db.js";
import { UserFacingError } from "./errors.js";
import { listProjects, projectViews } from "./projects.js";
import { activeReminders } from "./reminders.js";
import { addDays, currentInstant, isValidDate, localNow } from "./time.js";

/**
 * Structured, minimal memory of the user's work: priorities, commitments, constraints, decisions and what is paused.
 * Tasks, projects, deadlines and recorded time are NOT copied here — those records are the source of truth.
 *
 * The user can add, correct, re-label and remove anything directly. Nikki can only propose changes; they apply when
 * the user confirms. Tentative things (ideas, assumptions, recommendations) expire for review so one casual remark
 * never becomes a permanent fact.
 */

export const KINDS: MemoryKind[] = ["focus", "priority", "commitment", "goal", "constraint", "decision", "paused", "idea"];
export const STATUSES: MemoryStatus[] = ["confirmed", "tentative", "assumption", "recommendation", "approved", "outdated"];
const TENTATIVE = new Set<MemoryStatus>(["tentative", "assumption", "recommendation"]);
const REVIEW_DAYS = 30;
export const MAX_ITEMS = 80;
const MAX_TEXT = 300;

interface Row {
  id: string;
  kind: MemoryKind;
  text: string;
  status: MemoryStatus;
  rationale: string;
  source: "user" | "nikki";
  project_id: string | null;
  review_after: string | null;
  created_at: string;
  updated_at: string;
}

const toItem = (r: Row, today: string): MemoryItem => ({
  id: r.id,
  kind: r.kind,
  text: r.text,
  status: r.status,
  rationale: r.rationale,
  source: r.source,
  projectId: r.project_id,
  reviewAfter: r.review_after,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  stale: !!r.review_after && r.review_after < today && r.status !== "outdated",
});

export function listMemory(db: DB, today: string): MemoryItem[] {
  return (db.prepare("SELECT * FROM memory_items ORDER BY created_at, rowid").all() as Row[]).map((r) => toItem(r, today));
}

export function getMemory(db: DB, id: string, today: string): MemoryItem | null {
  const r = db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as Row | undefined;
  return r ? toItem(r, today) : null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export interface MemoryInput {
  kind: MemoryKind;
  text: string;
  status?: MemoryStatus;
  rationale?: string;
  source: "user" | "nikki";
  projectId?: string | null;
  reviewAfter?: string | null;
}

function reviewDate(status: MemoryStatus, given: string | null | undefined, today: string): string | null {
  if (given && isValidDate(given)) return given;
  return TENTATIVE.has(status) ? addDays(today, REVIEW_DAYS) : null;
}

export function addMemory(db: DB, input: MemoryInput, today: string): MemoryItem {
  const text = input.text.trim().slice(0, MAX_TEXT);
  if (!text) throw new UserFacingError("There's nothing to remember there.", 400, "invalid");
  if (!KINDS.includes(input.kind)) throw new UserFacingError("Unknown kind of memory.", 400, "invalid");
  const status = input.status ?? (input.source === "user" ? "confirmed" : "tentative");
  if (!STATUSES.includes(status)) throw new UserFacingError("Unknown status.", 400, "invalid");
  const live = listMemory(db, today).filter((m) => m.status !== "outdated");
  const dup = live.find((m) => m.kind === input.kind && norm(m.text) === norm(text));
  if (dup) return dup; // never store the same thing twice
  if (live.length >= MAX_ITEMS) throw new UserFacingError("Nikki is already remembering a lot. Remove or mark some items as outdated first.", 409, "too_many");
  const id = newId("mem");
  const now = clockIso();
  db.prepare("INSERT INTO memory_items (id, kind, text, status, rationale, source, project_id, review_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    input.kind,
    text,
    status,
    (input.rationale ?? "").trim().slice(0, 400),
    input.source,
    input.projectId ?? null,
    reviewDate(status, input.reviewAfter, today),
    now,
    now,
  );
  return getMemory(db, id, today)!;
}

export function updateMemory(db: DB, id: string, patch: { text?: string; status?: MemoryStatus; kind?: MemoryKind; rationale?: string; reviewAfter?: string | null; keep?: boolean }, today: string): MemoryItem {
  const cur = getMemory(db, id, today);
  if (!cur) throw new UserFacingError("That item wasn't found.", 404, "not_found");
  if (patch.status && !STATUSES.includes(patch.status)) throw new UserFacingError("Unknown status.", 400, "invalid");
  if (patch.kind && !KINDS.includes(patch.kind)) throw new UserFacingError("Unknown kind.", 400, "invalid");
  const status = patch.status ?? cur.status;
  let review = patch.reviewAfter !== undefined ? patch.reviewAfter : cur.reviewAfter;
  // Keeping a stale item renews it; becoming tentative starts the clock; becoming firm stops it.
  if (patch.keep) review = TENTATIVE.has(status) ? addDays(today, REVIEW_DAYS) : null;
  else if (patch.status && patch.status !== cur.status) review = TENTATIVE.has(status) ? addDays(today, REVIEW_DAYS) : null;
  db.prepare("UPDATE memory_items SET text = ?, status = ?, kind = ?, rationale = ?, review_after = ?, updated_at = ? WHERE id = ?").run(
    patch.text !== undefined ? patch.text.trim().slice(0, MAX_TEXT) || cur.text : cur.text,
    status,
    patch.kind ?? cur.kind,
    patch.rationale !== undefined ? patch.rationale.trim().slice(0, 400) : cur.rationale,
    review,
    clockIso(),
    id,
  );
  return getMemory(db, id, today)!;
}

export function removeMemory(db: DB, id: string) {
  if (db.prepare("DELETE FROM memory_items WHERE id = ?").run(id).changes === 0) throw new UserFacingError("That item wasn't found.", 404, "not_found");
}

/** Checks a proposed change before it is shown to the user. Returns problems (empty = fine). */
export function validateMemoryUpdates(updates: MemoryUpdate[], db: DB, today: string): string[] {
  const errors: string[] = [];
  const live = new Map(listMemory(db, today).map((m) => [m.id, m]));
  for (const u of updates) {
    if (u.op !== "add" && (!u.itemId || !live.has(u.itemId))) errors.push(`Memory change refers to an item that doesn't exist ("${u.itemId}").`);
    if ((u.op === "add" || u.op === "update") && !u.text.trim()) errors.push("A memory change has no text.");
    if (u.reviewAfter && !isValidDate(u.reviewAfter)) errors.push(`Memory review date "${u.reviewAfter}" isn't valid.`);
  }
  if (updates.filter((u) => u.op === "add").length > 5) errors.push("Propose at most five new things to remember at once.");
  return errors;
}

/** Applies the changes the user confirmed. */
export function applyMemoryUpdates(db: DB, updates: MemoryUpdate[], today: string) {
  for (const u of updates) {
    if (u.op === "add") addMemory(db, { kind: u.kind, text: u.text, status: u.status, rationale: u.rationale, projectId: u.projectId, reviewAfter: u.reviewAfter, source: "nikki" }, today);
    else if (u.op === "update" && u.itemId) updateMemory(db, u.itemId, { text: u.text, status: u.status, kind: u.kind, rationale: u.rationale, reviewAfter: u.reviewAfter }, today);
    else if (u.op === "outdate" && u.itemId) updateMemory(db, u.itemId, { status: "outdated" }, today);
    else if (u.op === "remove" && u.itemId) removeMemory(db, u.itemId);
  }
}

const tokens = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 3));

/**
 * What goes to the model: firm items always (capped), tentative ones only if they relate to what the user just said,
 * never outdated or stale ones. Bounded in size so cost stays flat as memory grows.
 */
export function memoryForModel(items: MemoryItem[], userText: string) {
  const usable = items.filter((m) => m.status !== "outdated" && !m.stale);
  const firm = usable.filter((m) => m.status === "confirmed" || m.status === "approved");
  const soft = usable.filter((m) => TENTATIVE.has(m.status));
  const want = tokens(userText);
  const related = soft
    .map((m) => ({ m, score: [...tokens(m.text)].filter((t) => want.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => x.m);
  const order: Record<MemoryKind, number> = { focus: 0, priority: 1, commitment: 2, constraint: 3, paused: 4, goal: 5, decision: 6, idea: 7 };
  const pick = [...firm.sort((a, b) => order[a.kind] - order[b.kind] || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 24), ...related];
  return {
    items: pick.map((m) => ({ id: m.id, kind: m.kind, status: m.status, text: m.text.slice(0, 240), ...(m.rationale ? { why: m.rationale.slice(0, 200) } : {}), ...(m.projectId ? { project_id: m.projectId } : {}), since: m.updatedAt.slice(0, 10) })),
    not_shown: usable.length - pick.length,
    outdated_count: items.filter((m) => m.status === "outdated").length,
    needs_review: items.filter((m) => m.stale && m.kind === "decision").map((m) => ({ id: m.id, text: m.text.slice(0, 120) })).slice(0, 5),
  };
}

// ---------- weekly review facts ----------

/** The last seven days, counted from real records. Anything that couldn't be counted is listed as a data gap. */
export function weeklyFacts(db: DB, tz: string, tasks: Task[]): WeeklyFacts {
  const now = localNow(tz);
  const to = now.date;
  const from = addDays(to, -6);
  const inWeek = (iso: string | null) => {
    if (!iso) return false;
    const d = localNow(tz, new Date(iso)).date;
    return d >= from && d <= to;
  };
  const projects = listProjects(db);
  const projTitle = new Map(projects.map((p) => [p.id, p.title]));
  const done = tasks.filter((t) => t.status === "done" && t.type === "action" && inWeek(t.completedAt));
  const sessions: ReturnType<typeof listSessions> = [];
  for (let d = from; d <= to; d = addDays(d, 1)) sessions.push(...listSessions(db, d));
  const verified = sessions.filter((s) => s.verified);
  const byTask = new Map<string, number>();
  for (const s of verified) byTask.set(s.taskId, (byTask.get(s.taskId) ?? 0) + s.minutes);
  const perDay = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(from, i);
    return { date, minutes: verified.filter((s) => s.date === date).reduce((a, s) => a + s.minutes, 0) };
  });
  const open = tasks.filter((t) => t.type === "action" && t.status === "open");
  const unfinished = open.filter((t) => t.plannedDate && t.plannedDate >= from && t.plannedDate <= to && !t.timerStartedAt).slice(0, 15);
  const views = projectViews(db, tasks, to);
  const taskProject = new Map(tasks.map((t) => [t.id, t.projectId]));
  const live = views.filter((p) => p.status === "active");
  const pv = views
    .filter((p) => p.status === "active" || p.status === "paused")
    .map((p) => {
      const minutes = verified.filter((s) => taskProject.get(s.taskId) === p.id).reduce((a, s) => a + s.minutes, 0);
      const last = p.progress.lastWorkedAt ? Math.max(0, Math.round((currentInstant().getTime() - new Date(p.progress.lastWorkedAt).getTime()) / 86400000)) : null;
      return {
        id: p.id,
        title: p.title,
        status: p.status,
        minutesThisWeek: minutes,
        tasksDoneThisWeek: tasks.filter((t) => t.projectId === p.id && t.status === "done" && inWeek(t.completedAt)).length,
        milestonesDoneThisWeek: p.milestones.filter((m) => m.status === "done" && inWeek(m.doneAt)).length,
        daysSinceWorked: last,
        overdueMilestones: p.progress.overdueMilestoneIds.length,
        nextActionTitles: p.progress.nextActionIds.map((id) => tasks.find((t) => t.id === id)?.title ?? "").filter(Boolean),
      };
    });
  const end = addDays(to, 7);
  const memory = listMemory(db, to);
  const gaps: string[] = [];
  const noTime = done.filter((t) => !byTask.get(t.id) && !t.spentMinutes);
  if (noTime.length) gaps.push(`${noTime.length} finished task${noTime.length > 1 ? "s have" : " has"} no recorded time, so the hours below undercount the work.`);
  const quiet = perDay.filter((d) => d.minutes === 0).length;
  if (quiet >= 4) gaps.push(`No time was recorded on ${quiet} of the 7 days. Work done without the timer isn't counted.`);
  const unchecked = sessions.filter((s) => !s.verified).reduce((a, s) => a + s.minutes, 0);
  if (unchecked) gaps.push(`${unchecked} minutes of timer time are waiting to be checked and aren't counted.`);
  const unknown = open.filter((t) => t.estimateMinutes == null).length;
  if (unknown) gaps.push(`${unknown} open task${unknown > 1 ? "s have" : " has"} no estimate, so workload can't be fully judged.`);
  if (!done.length && !verified.length) gaps.push("There's very little recorded this week, so any conclusion would be a guess.");
  return {
    from,
    to,
    completed: done.map((t) => ({ id: t.id, title: t.title, minutes: byTask.get(t.id) ?? 0, projectTitle: t.projectId ? (projTitle.get(t.projectId) ?? null) : null })).slice(0, 25),
    unfinished: unfinished.map((t) => ({ id: t.id, title: t.title, plannedDate: t.plannedDate })),
    recordedMinutes: verified.reduce((a, s) => a + s.minutes, 0),
    uncheckedMinutes: unchecked,
    perDay,
    projects: pv,
    limitedAttention: live.filter((p) => !pv.find((x) => x.id === p.id)?.minutesThisWeek).map((p) => p.title),
    upcoming: {
      deadlines: tasks
        .filter((t) => t.status !== "done" && t.deadline && t.deadline >= to && t.deadline <= end)
        .sort((a, b) => a.deadline!.localeCompare(b.deadline!))
        .slice(0, 10)
        .map((t) => ({ title: t.title, date: t.deadline! })),
      commitments: listMeetingsBetween(db, to, end).length,
      reminders: activeReminders(db, tz).filter((r) => r.localDate >= to && r.localDate <= end).length,
    },
    decisionsThisWeek: memory.filter((m) => m.kind === "decision" && (m.status === "approved" || m.status === "confirmed") && m.updatedAt.slice(0, 10) >= from).map((m) => ({ text: m.text })),
    decisionsToReview: memory.filter((m) => m.kind === "decision" && m.stale).map((m) => ({ text: m.text })),
    dataGaps: gaps,
  };
}

const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);

/** A plain, factual summary used when no model is available (Demo mode). Every number comes from the app's records. */
export function weeklySummary(f: WeeklyFacts): string {
  const lines = [`Your week, ${f.from} to ${f.to}.`];
  lines.push(`Done: ${f.completed.length} task${f.completed.length === 1 ? "" : "s"}${f.recordedMinutes ? `, ${hm(f.recordedMinutes)} of recorded work` : ", no recorded time"}.`);
  if (f.unfinished.length) lines.push(`Planned but not finished: ${f.unfinished.map((t) => t.title).slice(0, 5).join("; ")}${f.unfinished.length > 5 ? ` and ${f.unfinished.length - 5} more` : ""}.`);
  for (const p of f.projects.filter((x) => x.status === "active")) {
    lines.push(`${p.title}: ${p.minutesThisWeek ? `${hm(p.minutesThisWeek)} this week` : "no time recorded this week"}, ${p.tasksDoneThisWeek} task${p.tasksDoneThisWeek === 1 ? "" : "s"} done${p.overdueMilestones ? `, ${p.overdueMilestones} milestone overdue` : ""}.`);
  }
  if (f.upcoming.deadlines.length) lines.push(`Coming up: ${f.upcoming.deadlines.slice(0, 3).map((d) => `${d.title} (${d.date})`).join("; ")}.`);
  if (f.dataGaps.length) lines.push(`Limits of this review: ${f.dataGaps.join(" ")}`);
  return lines.join("\n");
}

/** Verified minutes per project over the last N days, so advice can see where attention has actually gone. */
export function recentMinutesByProject(db: DB, tz: string, tasks: Task[], days: number): Map<string, number> {
  const today = localNow(tz).date;
  const owner = new Map(tasks.map((t) => [t.id, t.projectId]));
  const out = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    for (const s of listSessions(db, addDays(today, -i))) {
      const pid = owner.get(s.taskId);
      if (pid && s.verified) out.set(pid, (out.get(pid) ?? 0) + s.minutes);
    }
  }
  return out;
}
