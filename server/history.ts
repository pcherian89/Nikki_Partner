import type { HistoryItem, HistoryStatus } from "../shared/types.js";
import { DB, listBlockOutcomes, listSessions } from "./db.js";
import { localNow, toMinutes } from "./time.js";

/**
 * The record of one day, worked out from every plan version saved for that date plus the user's recorded outcomes.
 * Nothing here is stored twice and nothing is ever deleted: replanning writes a new plan version, the old one stays,
 * and this view reads them all. A block is identified by its task and start time.
 *
 * A status is only "done"/"partial"/"skipped" if the user said so — or if they finished the task itself. The passage of
 * time alone never marks anything done, skipped or moved; it just makes a block "unconfirmed".
 */
export function dayHistory(db: DB, date: string, tz: string, now: { date: string; time: string }): HistoryItem[] {
  const versions = db.prepare("SELECT id, version, created_at AS createdAt FROM plans WHERE date = ? ORDER BY version").all(date) as {
    id: string;
    version: number;
    createdAt: string;
  }[];
  if (!versions.length) return [];
  const latest = versions[versions.length - 1].version;
  const versionOf = new Map(versions.map((v) => [v.id, v]));
  const rows = db
    .prepare(
      `SELECT plan_id AS planId, start, end, kind, task_id AS taskId, title FROM plan_blocks
       WHERE plan_id IN (${versions.map(() => "?").join(",")}) AND kind IN ('focus','task') AND task_id IS NOT NULL
       ORDER BY position`,
    )
    .all(...versions.map((v) => v.id)) as { planId: string; start: string; end: string; kind: "focus" | "task"; taskId: string; title: string }[];

  type Seen = { taskId: string; start: string; end: string; originalEnd: string; kind: "focus" | "task"; title: string; first: number; last: number };
  const seen = new Map<string, Seen>();
  for (const r of rows.sort((a, b) => versionOf.get(a.planId)!.version - versionOf.get(b.planId)!.version)) {
    const v = versionOf.get(r.planId)!.version;
    const key = `${r.taskId}|${r.start}`;
    const cur = seen.get(key);
    if (!cur) seen.set(key, { taskId: r.taskId, start: r.start, end: r.end, originalEnd: r.end, kind: r.kind, title: r.title, first: v, last: v });
    else {
      cur.end = r.end;
      cur.title = r.title;
      cur.kind = r.kind;
      cur.last = v;
    }
  }
  if (!seen.size) return [];

  const taskRows = db
    .prepare(`SELECT id, status, completed_at AS completedAt, deleted FROM tasks WHERE id IN (${[...new Set([...seen.values()].map((s) => s.taskId))].map(() => "?").join(",")})`)
    .all(...new Set([...seen.values()].map((s) => s.taskId))) as { id: string; status: string; completedAt: string | null; deleted: number }[];
  const tasks = new Map(taskRows.map((t) => [t.id, t]));
  const outcomes = new Map(listBlockOutcomes(db, date).map((o) => [`${o.taskId}|${o.start}`, o]));
  // Actual work is attached to the block it fell in: a confirmed session to the block it was confirmed for, a timer
  // session to the block that was running when it started (else the latest block that had begun, else the first).
  const worked = new Map<string, number>();
  const blocksOf = new Map<string, Seen[]>();
  for (const s of seen.values()) blocksOf.set(s.taskId, [...(blocksOf.get(s.taskId) ?? []), s].sort((a, b) => toMinutes(a.start) - toMinutes(b.start)));
  for (const s of listSessions(db, date)) {
    const mine = blocksOf.get(s.taskId);
    if (!mine?.length) continue;
    let target = s.blockStart ? mine.find((b) => b.start === s.blockStart) : undefined;
    if (!target && s.startedAt) {
      const t = toMinutes(localNow(tz, new Date(s.startedAt)).time);
      target = [...mine].reverse().find((b) => toMinutes(b.start) <= t) ?? mine[0];
    }
    target ??= mine[0];
    const k = `${target.taskId}|${target.start}`;
    worked.set(k, (worked.get(k) ?? 0) + s.minutes);
  }
  const createdAtOf = (version: number) => versions.find((v) => v.version === version)?.createdAt ?? null;

  const items: HistoryItem[] = [];
  for (const [key, s] of seen) {
    const task = tasks.get(s.taskId);
    const rec = outcomes.get(key);
    const inCurrent = s.last === latest;
    const startMin = toMinutes(s.start);
    let status: HistoryStatus;
    let recorded = false;
    if (rec) {
      status = rec.outcome;
      recorded = true;
    } else if (task?.deleted) {
      status = "removed";
    } else if (task?.status === "done" && task.completedAt) {
      // The user finished the task itself: earlier blocks count as done, later ones weren't needed.
      const doneAt = localNow(tz, new Date(task.completedAt));
      if (doneAt.date < date) status = "replaced";
      else if (doneAt.date > date) status = "unconfirmed";
      else status = startMin <= toMinutes(doneAt.time) ? "done" : "replaced";
    } else if (!inCurrent) {
      // Dropped from a later plan version. Before it began, that is a reschedule; once it had begun, nobody said what happened.
      const removedAt = createdAtOf(s.last + 1);
      const at = removedAt ? localNow(tz, new Date(removedAt)) : null;
      status = !at || at.date < date || (at.date === date && toMinutes(at.time) <= startMin) ? "rescheduled" : "unconfirmed";
    } else if (date < now.date || (date === now.date && toMinutes(s.end) <= toMinutes(now.time))) {
      status = "unconfirmed";
    } else {
      status = "planned";
    }
    if (status === "planned") continue;
    items.push({
      key,
      date,
      taskId: s.taskId,
      title: s.title,
      start: s.start,
      end: s.end,
      originalEnd: s.originalEnd,
      kind: s.kind,
      status,
      recorded,
      note: rec?.note ?? null,
      plannedMinutes: toMinutes(s.end) - startMin,
      workedMinutes: worked.get(key) ?? 0,
      inCurrentPlan: inCurrent,
    });
  }
  return items.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

