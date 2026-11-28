import { randomUUID } from "node:crypto";
import { clockIso, newId, type DB } from "../db.js";
import { currentInstant, isValidTime, isValidTimeZone, localNow, localToUtc, addDays } from "../time.js";
import { logActivity } from "./activity.js";
import { controls } from "./controls.js";
import { notify } from "./notifications.js";

/**
 * Persistent background jobs, stored in SQLite so they survive restarts and redeploys.
 *
 * - A job is claimed with a lease (a conditional UPDATE), so it never runs twice at once, even if two server
 *   processes overlap during a deploy. A lease that is not renewed expires and the job becomes claimable again.
 * - Schedules: every N minutes, daily at a local time (India by default), or once at an instant.
 * - Missed runs (server was down): `catch_up = "once"` runs one catch-up then returns to schedule; `"skip"` skips
 *   runs more than 30 minutes late.
 * - Failures retry with exponential back-off up to `max_attempts`, then wait for the next regular slot and notify.
 * - Agent jobs do nothing while agents are paused.
 *
 * The existing reminder (20 s) and calendar (15 min) timers are unchanged; they are idempotent already.
 */

export type Schedule = { type: "interval"; minutes: number } | { type: "daily"; time: string; tz?: string } | { type: "once"; at: string };
export type JobHandler = (db: DB, job: Job) => Promise<void> | void;

export interface Job {
  id: string;
  kind: string;
  name: string;
  schedule: Schedule;
  payload: Record<string, unknown>;
  enabled: boolean;
  system: boolean;
  nextRunAt: string | null;
  attempts: number;
  maxAttempts: number;
  catchUp: "once" | "skip";
  lastStatus: string | null;
  lastError: string | null;
  lastRunAt: string | null;
}

type Row = {
  id: string;
  kind: string;
  name: string;
  schedule: string;
  payload: string;
  enabled: number;
  system: number;
  next_run_at: string | null;
  attempts: number;
  max_attempts: number;
  catch_up: "once" | "skip";
  last_status: string | null;
  last_error: string | null;
  last_run_at: string | null;
};
const toJob = (r: Row): Job => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  schedule: JSON.parse(r.schedule),
  payload: JSON.parse(r.payload),
  enabled: !!r.enabled,
  system: !!r.system,
  nextRunAt: r.next_run_at,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  catchUp: r.catch_up,
  lastStatus: r.last_status,
  lastError: r.last_error,
  lastRunAt: r.last_run_at,
});

const handlers = new Map<string, JobHandler>();
export const registerJobHandler = (kind: string, fn: JobHandler) => handlers.set(kind, fn);

const DEFAULT_TZ = "Asia/Kolkata";
const LATE_GRACE_MS = 30 * 60_000;
const LEASE_MS = 10 * 60_000;

/** The next time a schedule is due, strictly after `from`. Null for a one-off that has passed. */
export function nextRun(s: Schedule, from: Date): string | null {
  if (s.type === "interval") return new Date(from.getTime() + Math.max(1, s.minutes) * 60_000).toISOString();
  if (s.type === "once") return new Date(s.at).getTime() > from.getTime() ? new Date(s.at).toISOString() : null;
  const tz = s.tz && isValidTimeZone(s.tz) ? s.tz : DEFAULT_TZ;
  const today = localNow(tz, from).date;
  for (const d of [today, addDays(today, 1), addDays(today, 2)]) {
    const at = localToUtc(d, s.time, tz);
    if (at.getTime() > from.getTime()) return at.toISOString();
  }
  return null;
}

export function validateSchedule(s: Schedule) {
  if (s.type === "interval" && !(s.minutes >= 1 && s.minutes <= 7 * 24 * 60)) throw new Error("Interval must be 1 minute to 7 days.");
  if (s.type === "daily" && !isValidTime(s.time)) throw new Error("Daily time must be HH:MM.");
  if (s.type === "once" && Number.isNaN(new Date(s.at).getTime())) throw new Error("Invalid one-off time.");
}

export function upsertJob(
  db: DB,
  j: { id?: string; kind: string; name: string; schedule: Schedule; payload?: Record<string, unknown>; system?: boolean; maxAttempts?: number; catchUp?: "once" | "skip"; enabled?: boolean },
): Job {
  validateSchedule(j.schedule);
  const id = j.id ?? newId("job");
  const existing = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
  const sched = JSON.stringify(j.schedule);
  if (existing) {
    // Keep the next due time unless the schedule itself changed.
    const next = existing.schedule === sched ? existing.next_run_at : nextRun(j.schedule, currentInstant());
    db.prepare("UPDATE jobs SET kind = ?, name = ?, schedule = ?, payload = ?, max_attempts = ?, catch_up = ?, next_run_at = ?, enabled = ? WHERE id = ?").run(
      j.kind,
      j.name,
      sched,
      JSON.stringify(j.payload ?? {}),
      j.maxAttempts ?? existing.max_attempts,
      j.catchUp ?? existing.catch_up,
      next,
      j.enabled === undefined ? existing.enabled : j.enabled ? 1 : 0,
      id,
    );
  } else {
    db.prepare(
      "INSERT INTO jobs (id, kind, name, schedule, payload, enabled, system, next_run_at, max_attempts, catch_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, j.kind, j.name, sched, JSON.stringify(j.payload ?? {}), j.enabled === false ? 0 : 1, j.system ? 1 : 0, nextRun(j.schedule, currentInstant()), j.maxAttempts ?? 3, j.catchUp ?? "once", clockIso());
  }
  return getJob(db, id)!;
}

export function getJob(db: DB, id: string): Job | null {
  const r = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
  return r ? toJob(r) : null;
}

export const listJobs = (db: DB): Job[] => (db.prepare("SELECT * FROM jobs ORDER BY system DESC, name").all() as Row[]).map(toJob);

export function setJobEnabled(db: DB, id: string, enabled: boolean) {
  const j = getJob(db, id);
  if (!j) return;
  db.prepare("UPDATE jobs SET enabled = ?, next_run_at = ? WHERE id = ?").run(enabled ? 1 : 0, enabled ? nextRun(j.schedule, currentInstant()) : j.nextRunAt, id);
  logActivity(db, "user", enabled ? "job.enabled" : "job.disabled", id);
}

export function recentRuns(db: DB, jobId: string, limit = 10) {
  return db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?").all(jobId, limit);
}

/** Runs left "running" by a process that stopped are marked interrupted (their job is retried by its schedule). */
export function recoverJobs(db: DB) {
  const n = db.prepare("UPDATE job_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(clockIso()).changes;
  db.prepare("UPDATE jobs SET lease_owner = NULL, lease_until = NULL WHERE lease_until IS NOT NULL AND lease_until < ?").run(clockIso());
  if (n) logActivity(db, "system", "jobs.recovered", null, { count: n });
}

const OWNER = `proc_${randomUUID().slice(0, 8)}`;
const running = new Set<Promise<void>>();
let maxConcurrent = 2;
export const setMaxConcurrentJobs = (n: number) => (maxConcurrent = n);

/** One pass: claim and run every due job (up to the concurrency limit). Returns the ids it ran. */
export async function runDueJobs(db: DB): Promise<string[]> {
  const now = currentInstant();
  const nowIso = now.toISOString();
  const due = db.prepare("SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 20").all(nowIso) as Row[];
  const ran: string[] = [];
  for (const r of due) {
    if (running.size >= maxConcurrent) break;
    const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
    const claimed = db
      .prepare("UPDATE jobs SET lease_owner = ?, lease_until = ? WHERE id = ? AND enabled = 1 AND next_run_at <= ? AND (lease_until IS NULL OR lease_until < ?)")
      .run(OWNER, leaseUntil, r.id, nowIso, nowIso).changes;
    if (!claimed) continue;
    const job = toJob(r);
    const p = runClaimed(db, job, now).finally(() => running.delete(p));
    running.add(p);
    ran.push(job.id);
    await p; // sequential within one pass keeps SQLite writes simple; concurrency is across passes/processes
  }
  return ran;
}

async function runClaimed(db: DB, job: Job, now: Date) {
  const scheduledFor = job.nextRunAt;
  const finish = (status: string, error: string | null, next: string | null, attempts: number) => {
    db.prepare("UPDATE jobs SET lease_owner = NULL, lease_until = NULL, last_status = ?, last_error = ?, last_run_at = ?, next_run_at = ?, attempts = ? WHERE id = ?").run(
      status,
      error,
      clockIso(),
      next,
      attempts,
      job.id,
    );
  };
  // Missed slot and the job prefers to skip: move on without running.
  if (job.catchUp === "skip" && scheduledFor && now.getTime() - new Date(scheduledFor).getTime() > LATE_GRACE_MS) {
    finish("skipped_late", null, nextRun(job.schedule, now), 0);
    return;
  }
  if (job.kind.startsWith("agent") && controls(db).agentsPaused) {
    finish("skipped_paused", null, nextRun(job.schedule, now), 0);
    return;
  }
  const handler = handlers.get(job.kind);
  const runId = newId("jrun");
  db.prepare("INSERT INTO job_runs (id, job_id, scheduled_for, started_at, status) VALUES (?, ?, ?, ?, 'running')").run(runId, job.id, scheduledFor, clockIso());
  try {
    if (!handler) throw new Error(`No handler for job kind "${job.kind}".`);
    await handler(db, job);
    db.prepare("UPDATE job_runs SET status = 'succeeded', finished_at = ? WHERE id = ?").run(clockIso(), runId);
    finish("succeeded", null, nextRun(job.schedule, now), 0);
  } catch (e) {
    const msg = ((e as Error)?.message ?? String(e)).slice(0, 300);
    db.prepare("UPDATE job_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?").run(clockIso(), msg, runId);
    const attempts = job.attempts + 1;
    if (attempts < job.maxAttempts) {
      const backoff = Math.min(60, 2 ** attempts) * 60_000; // 2, 4, 8 … minutes, at most an hour
      finish("retrying", msg, new Date(now.getTime() + backoff).toISOString(), attempts);
    } else {
      finish("failed", msg, nextRun(job.schedule, now), 0);
      logActivity(db, `job:${job.id}`, "job.failed", job.id, { attempt: attempts });
      await notify(db, { category: "system", priority: "normal", title: `Background job failed: ${job.name}`, body: "It will try again at its next scheduled time.", link: "/?view=context#jobs", dedupeKey: `jobfail:${job.id}:${localNow(DEFAULT_TZ, now).date}` }).catch(() => {});
    }
  }
}

let timer: NodeJS.Timeout | null = null;
let stopping = false;

/** Starts the loop (every 30 s). */
export function startJobRunner(getDbFn: () => DB, everyMs = 30_000) {
  stopping = false;
  const tick = () => {
    if (stopping) return;
    runDueJobs(getDbFn()).catch((e) => console.warn(`[jobs] ${(e as Error).message}`));
  };
  timer = setInterval(tick, everyMs);
  timer.unref();
  setTimeout(tick, 2_000).unref();
}

/** Graceful shutdown: stop claiming, wait (up to 10 s) for running jobs to finish. Unfinished ones are recovered on the next start. */
export async function stopJobRunner(timeoutMs = 10_000) {
  stopping = true;
  if (timer) clearInterval(timer);
  await Promise.race([Promise.allSettled([...running]), new Promise((r) => setTimeout(r, timeoutMs))]);
}
