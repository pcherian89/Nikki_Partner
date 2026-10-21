import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { currentInstant, isValidTimeZone, localDateOf } from "./time.js";
import { assessTimer } from "./timerRules.js";
import type {
  TaskDraft,
  TaskStep,
  WrapUp,
  ChatMessage,
  Meeting,
  Plan,
  PlanBlock,
  PlanDraft,
  Profile,
  Proposal,
  Task,
  Workspace,
} from "../shared/types.js";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  estimate_minutes INTEGER,
  deadline TEXT,
  project TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  source TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_plan_version INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  proposal_id TEXT,
  source TEXT NOT NULL,
  UNIQUE (date, version)
);
CREATE TABLE IF NOT EXISTS plan_blocks (
  plan_id TEXT NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT,
  meeting_id TEXT,
  title TEXT NOT NULL,
  PRIMARY KEY (plan_id, id)
);
CREATE TABLE IF NOT EXISTS task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  minutes INTEGER,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_drafts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  format TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  next_step TEXT NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS journal (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- What was actually worked on: one row per stretch of work (timer start..stop, or a confirmed block).
CREATE TABLE IF NOT EXISTS work_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  date TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  minutes INTEGER NOT NULL,
  source TEXT NOT NULL,
  block_start TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_work_sessions_date ON work_sessions (date);
-- The user's answer for a planned block (done / partly / skipped / rescheduled). Planned time itself lives in plan_blocks.
CREATE TABLE IF NOT EXISTS block_outcomes (
  date TEXT NOT NULL,
  task_id TEXT NOT NULL,
  start TEXT NOT NULL,
  outcome TEXT NOT NULL,
  minutes INTEGER,
  note TEXT,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (date, task_id, start)
);
-- Long-term goals. Tasks point at a project (and optionally a milestone); there is no separate project task system.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  target_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  assumptions TEXT NOT NULL DEFAULT '[]',
  dependencies TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  target_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  position INTEGER NOT NULL DEFAULT 0,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones (project_id, position);
-- Something to remember at a time. Not a task, a deadline, a scheduled block or a commitment.
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  task_id TEXT,
  project_id TEXT,
  remind_at TEXT NOT NULL,
  anchor TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  fired_at TEXT,
  done_at TEXT,
  channels TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (status, remind_at);
-- Devices that allowed notifications when the app is closed. Never exported.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  client_id TEXT,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);
-- Server-only secrets (push signing keys). Never exported.
CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  response TEXT
);
`;

const dbs = new Map<Workspace, DB>();

/** Bump when the stored layout changes. Existing databases are copied aside before they are migrated. */
export const SCHEMA_VERSION = 5; // 5: projects, milestones, tasks.project_id/milestone_id. 4: reminders, push_subscriptions, secrets. 2: work_sessions, block_outcomes. 3: priority, optional, deadline_time, verified sessions, pinned/provisional blocks
const KEEP_SNAPSHOTS = 5;

/**
 * Before an existing database is migrated, copy it next to itself (same volume) so a bad migration can be undone
 * by putting the copy back. Only additive changes are ever made, so older code keeps working on a migrated file.
 */
function snapshotBeforeMigration(db: DB, file: string, fromVersion: number) {
  try {
    const hasTasks = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get();
    if (!hasTasks) return; // a new database: nothing to protect
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = `${file}.v${fromVersion}-before-v${SCHEMA_VERSION}-${stamp}.bak`;
    db.prepare("VACUUM INTO ?").run(target);
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.v`;
    const old = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".bak"))
      .sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_SNAPSHOTS))) fs.rmSync(path.join(dir, f), { force: true });
    console.log(`[db] Saved a copy of ${path.basename(file)} before upgrading it: ${target}`);
  } catch (e) {
    console.warn(`[db] Could not save a pre-upgrade copy of ${path.basename(file)}: ${(e as Error).message}`);
  }
}

/** Timestamps of things the user does. Follows NIKKI_FAKE_NOW (tests) so plan history lines up with the clock. */
export const clockIso = () => currentInstant().toISOString();

export function dbPath(ws: Workspace) {
  return ws === "demo" ? config.demoDatabasePath : config.databasePath;
}

export function getDb(ws: Workspace): DB {
  let db = dbs.get(ws);
  if (db) return db;
  const file = dbPath(ws);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version < SCHEMA_VERSION) snapshotBeforeMigration(db, file, version);
  db.exec(SCHEMA);
  migrate(db);
  if (version < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  dbs.set(ws, db);
  return db;
}

/** Closes every open connection (used to simulate a restart in tests, and for a clean shutdown). */
export function closeAll() {
  for (const db of dbs.values()) db.close();
  dbs.clear();
}

/** Adds columns introduced after the first release to existing databases. */
function migrate(db: DB) {
  const cols = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("project_id")) db.exec("ALTER TABLE tasks ADD COLUMN project_id TEXT");
  if (!cols.has("milestone_id")) db.exec("ALTER TABLE tasks ADD COLUMN milestone_id TEXT");
  if (!cols.has("actual_minutes")) db.exec("ALTER TABLE tasks ADD COLUMN actual_minutes INTEGER");
  if (!cols.has("spent_minutes")) db.exec("ALTER TABLE tasks ADD COLUMN spent_minutes INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("timer_started_at")) db.exec("ALTER TABLE tasks ADD COLUMN timer_started_at TEXT");
  if (!cols.has("planned_date")) db.exec("ALTER TABLE tasks ADD COLUMN planned_date TEXT");
  if (!cols.has("rollover_count")) db.exec("ALTER TABLE tasks ADD COLUMN rollover_count INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("priority")) db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
  if (!cols.has("optional")) db.exec("ALTER TABLE tasks ADD COLUMN optional INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("deadline_time")) db.exec("ALTER TABLE tasks ADD COLUMN deadline_time TEXT");
  const scols = new Set((db.prepare("PRAGMA table_info(work_sessions)").all() as { name: string }[]).map((c) => c.name));
  if (!scols.has("verified")) db.exec("ALTER TABLE work_sessions ADD COLUMN verified INTEGER NOT NULL DEFAULT 1");
  const bcols = new Set((db.prepare("PRAGMA table_info(plan_blocks)").all() as { name: string }[]).map((c) => c.name));
  if (!bcols.has("pinned")) db.exec("ALTER TABLE plan_blocks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  if (!bcols.has("provisional")) db.exec("ALTER TABLE plan_blocks ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0");
  const mcols = new Set((db.prepare("PRAGMA table_info(meetings)").all() as { name: string }[]).map((c) => c.name));
  if (!mcols.has("source")) db.exec("ALTER TABLE meetings ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  if (!mcols.has("feed_id")) db.exec("ALTER TABLE meetings ADD COLUMN feed_id TEXT");
  // One-time clean-up of context fields duplicated by an earlier version.
  const row = db.prepare("SELECT data FROM profile WHERE id = 1").get() as { data: string } | undefined;
  if (row) {
    const data = JSON.parse(row.data);
    let changed = false;
    for (const f of MULTILINE_FIELDS) {
      if (typeof data[f] === "string") {
        const clean = dedupeLines(data[f]);
        if (clean !== data[f]) {
          data[f] = clean;
          changed = true;
        }
      }
    }
    if (changed) db.prepare("UPDATE profile SET data = ? WHERE id = 1").run(JSON.stringify(data));
  }
}

export const TABLES = [
  "profile",
  "tasks",
  "task_steps",
  "task_drafts",
  "journal",
  "messages",
  "meetings",
  "proposals",
  "plans",
  "plan_blocks",
  "work_sessions",
  "block_outcomes",
  "reminders",
  "projects",
  "milestones",
  "requests",
  "settings",
];

/** Wipes every table in a workspace (used for Reset demo / Delete my data). */
export function wipe(db: DB) {
  db.transaction(() => {
    for (const t of [...TABLES, "push_subscriptions"]) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
  })();
}

export const nowIso = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

// ---------- profile ----------

export function emptyProfile(): Profile {
  return {
    name: "",
    projects: "",
    goals: "",
    mainOutcome: "",
    commitments: "",
    workStart: "",
    workEnd: "",
    timezone: "",
    preferences: "",
    updatedAt: null,
  };
}

export function getProfile(db: DB): Profile {
  const row = db.prepare("SELECT data, updated_at FROM profile WHERE id = 1").get() as
    | { data: string; updated_at: string | null }
    | undefined;
  if (!row) return emptyProfile();
  return { ...emptyProfile(), ...JSON.parse(row.data), updatedAt: row.updated_at };
}

/** Removes repeated lines (case/spacing-insensitive) from multi-line context fields. */
export function dedupeLines(text: string) {
  const seen = new Set<string>();
  return text
    .split(/\n/)
    .filter((line) => {
      const k = line.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.;]+$/, "");
      if (!k) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MULTILINE_FIELDS = ["projects", "goals", "commitments", "preferences"] as const;

export function saveProfile(db: DB, input: Profile) {
  const profile = { ...input };
  for (const f of MULTILINE_FIELDS) profile[f] = dedupeLines(profile[f] ?? "");
  const { updatedAt: _ignored, ...data } = profile;
  const ts = nowIso();
  db.prepare(
    "INSERT INTO profile (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  ).run(JSON.stringify(data), ts);
  return { ...profile, updatedAt: ts };
}

// ---------- tasks ----------

interface TaskRow {
  id: string;
  title: string;
  notes: string;
  type: Task["type"];
  status: Task["status"];
  estimate_minutes: number | null;
  deadline: string | null;
  project: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  source: Task["source"];
  actual_minutes: number | null;
  spent_minutes: number;
  timer_started_at: string | null;
  planned_date: string | null;
  rollover_count: number | null;
  priority: Task["priority"] | null;
  optional: number | null;
  deadline_time: string | null;
  project_id: string | null;
  milestone_id: string | null;
}

const rowToTask = (r: TaskRow, steps: TaskStep[] = []): Task => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  type: r.type,
  status: r.status,
  estimateMinutes: r.estimate_minutes,
  deadline: r.deadline,
  deadlineTime: r.deadline_time ?? null,
  projectId: r.project_id ?? null,
  milestoneId: r.milestone_id ?? null,
  priority: r.priority ?? "normal",
  optional: !!r.optional,
  plannedDate: r.planned_date ?? null,
  project: r.project,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
  source: r.source,
  actualMinutes: r.actual_minutes,
  spentMinutes: r.spent_minutes ?? 0,
  timerStartedAt: r.timer_started_at,
  rolloverCount: r.rollover_count ?? 0,
  steps,
});

interface StepRow {
  id: string;
  task_id: string;
  title: string;
  minutes: number | null;
  done: number;
}
const rowToStep = (r: StepRow): TaskStep => ({ id: r.id, title: r.title, minutes: r.minutes, done: !!r.done });

export function listTasks(db: DB): Task[] {
  const steps = new Map<string, TaskStep[]>();
  for (const r of db.prepare("SELECT * FROM task_steps ORDER BY task_id, position").all() as StepRow[]) {
    if (!steps.has(r.task_id)) steps.set(r.task_id, []);
    steps.get(r.task_id)!.push(rowToStep(r));
  }
  return (db.prepare("SELECT * FROM tasks WHERE deleted = 0 ORDER BY created_at, rowid").all() as TaskRow[]).map((r) =>
    rowToTask(r, steps.get(r.id) ?? []),
  );
}

export function getTask(db: DB, id: string): Task | null {
  const r = db.prepare("SELECT * FROM tasks WHERE id = ? AND deleted = 0").get(id) as TaskRow | undefined;
  if (!r) return null;
  const steps = (db.prepare("SELECT * FROM task_steps WHERE task_id = ? ORDER BY position").all(id) as StepRow[]).map(rowToStep);
  return rowToTask(r, steps);
}

/** Replaces a task's steps, keeping the done state of steps whose id is kept. */
export function replaceSteps(db: DB, taskId: string, steps: { id?: string; title: string; minutes: number | null; done?: boolean }[]) {
  db.transaction(() => {
    const old = new Map(
      (db.prepare("SELECT * FROM task_steps WHERE task_id = ?").all(taskId) as StepRow[]).map((r) => [r.id, r]),
    );
    db.prepare("DELETE FROM task_steps WHERE task_id = ?").run(taskId);
    const ins = db.prepare("INSERT INTO task_steps (id, task_id, position, title, minutes, done) VALUES (?, ?, ?, ?, ?, ?)");
    steps.forEach((st, i) => {
      const prev = st.id ? old.get(st.id) : undefined;
      ins.run(prev ? prev.id : newId("s"), taskId, i, st.title.trim(), st.minutes, (st.done ?? !!prev?.done) ? 1 : 0);
    });
  })();
}

export function setStepDone(db: DB, stepId: string, done: boolean) {
  return db.prepare("UPDATE task_steps SET done = ? WHERE id = ?").run(done ? 1 : 0, stepId).changes > 0;
}

// ---------- drafts ("Help me start") ----------

export function addDraft(db: DB, d: Omit<TaskDraft, "id" | "createdAt">): TaskDraft {
  const draft: TaskDraft = { ...d, id: newId("d"), createdAt: nowIso() };
  db.prepare(
    "INSERT INTO task_drafts (id, task_id, format, title, content, next_step, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(draft.id, draft.taskId, draft.format, draft.title, draft.content, draft.nextStep, draft.demo ? 1 : 0, draft.createdAt);
  return draft;
}

export function listDrafts(db: DB, limit = 40): TaskDraft[] {
  return (
    db.prepare("SELECT * FROM task_drafts ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as {
      id: string;
      task_id: string;
      format: string;
      title: string;
      content: string;
      next_step: string;
      demo: number;
      created_at: string;
    }[]
  ).map((r) => ({
    id: r.id,
    taskId: r.task_id,
    format: r.format,
    title: r.title,
    content: r.content,
    nextStep: r.next_step,
    demo: !!r.demo,
    createdAt: r.created_at,
  }));
}

export function deleteDraft(db: DB, id: string) {
  return db.prepare("DELETE FROM task_drafts WHERE id = ?").run(id).changes > 0;
}

// ---------- journal (evening wrap-ups) ----------

export function saveWrapUp(db: DB, w: Omit<WrapUp, "id" | "createdAt">): WrapUp {
  const entry: WrapUp = { ...w, id: newId("w"), createdAt: nowIso() };
  db.transaction(() => {
    db.prepare("DELETE FROM journal WHERE date = ? AND kind = 'wrapup'").run(w.date);
    const { id, date, createdAt, ...data } = entry;
    db.prepare("INSERT INTO journal (id, date, kind, data, created_at) VALUES (?, ?, 'wrapup', ?, ?)").run(id, date, JSON.stringify(data), createdAt);
  })();
  return entry;
}

function rowToWrapUp(r: { id: string; date: string; data: string; created_at: string }): WrapUp {
  return { id: r.id, date: r.date, createdAt: r.created_at, ...JSON.parse(r.data) };
}

export function wrapUpFor(db: DB, date: string): WrapUp | null {
  const r = db.prepare("SELECT * FROM journal WHERE date = ? AND kind = 'wrapup'").get(date) as
    | { id: string; date: string; data: string; created_at: string }
    | undefined;
  return r ? rowToWrapUp(r) : null;
}

export function lastWrapUpBefore(db: DB, date: string): WrapUp | null {
  const r = db.prepare("SELECT * FROM journal WHERE date < ? AND kind = 'wrapup' ORDER BY date DESC LIMIT 1").get(date) as
    | { id: string; date: string; data: string; created_at: string }
    | undefined;
  return r ? rowToWrapUp(r) : null;
}

export function createTask(
  db: DB,
  t: Partial<Task> & { title: string },
): Task {
  const ts = nowIso();
  const task: Task = {
    id: t.id ?? newId("t"),
    title: t.title.trim(),
    notes: t.notes ?? "",
    type: t.type ?? "action",
    status: t.status ?? "open",
    estimateMinutes: t.estimateMinutes ?? null,
    deadline: t.deadline ?? null,
    deadlineTime: t.deadline ? (t.deadlineTime ?? null) : null,
    priority: t.priority ?? "normal",
    optional: t.optional ?? false,
    plannedDate: t.plannedDate ?? null,
    project: t.project ?? null,
    projectId: t.projectId ?? null,
    milestoneId: t.milestoneId ?? null,
    createdAt: ts,
    updatedAt: ts,
    completedAt: t.status === "done" ? ts : null,
    source: t.source ?? "user",
    actualMinutes: t.actualMinutes ?? null,
    spentMinutes: 0,
    timerStartedAt: null,
    rolloverCount: 0,
    steps: [],
  };
  if (t.createdAt) task.createdAt = task.updatedAt = t.createdAt;
  db.prepare(
    `INSERT INTO tasks (id, title, notes, type, status, estimate_minutes, deadline, deadline_time, priority, optional, planned_date, project, project_id, milestone_id, created_at, updated_at, completed_at, source)
     VALUES (@id, @title, @notes, @type, @status, @estimateMinutes, @deadline, @deadlineTime, @priority, @optionalInt, @plannedDate, @project, @projectId, @milestoneId, @createdAt, @updatedAt, @completedAt, @source)`,
  ).run({
    ...task,
    optionalInt: task.optional ? 1 : 0,
    optional: undefined,
    steps: undefined,
    actualMinutes: undefined,
    spentMinutes: undefined,
    timerStartedAt: undefined,
    rolloverCount: undefined,
  });
  return task;
}

export function updateTask(db: DB, id: string, patch: Partial<Task>): Task | null {
  const cur = getTask(db, id);
  if (!cur) return null;
  const next: Task = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, updatedAt: nowIso(), steps: cur.steps };
  if (patch.status && patch.status !== cur.status) {
    next.completedAt = patch.status === "done" ? clockIso() : null;
  }
  // Finishing (or blocking) a task stops its focus timer and records the time spent.
  if (cur.timerStartedAt && patch.status && patch.status !== "open") {
    next.timerStartedAt = null;
    const s = recordTimerSession(db, cur);
    next.spentMinutes = cur.spentMinutes + (s?.verified ? s.minutes : 0);
  }
  if (patch.status === "done" && next.actualMinutes == null && next.spentMinutes > 0) {
    next.actualMinutes = next.spentMinutes;
  }
  db.prepare(
    `UPDATE tasks SET title=@title, notes=@notes, type=@type, status=@status, estimate_minutes=@estimateMinutes,
     deadline=@deadline, deadline_time=@deadlineTime, priority=@priority, optional=@optionalInt, planned_date=@plannedDate, project=@project, project_id=@projectId, milestone_id=@milestoneId, updated_at=@updatedAt, completed_at=@completedAt,
     actual_minutes=@actualMinutes, spent_minutes=@spentMinutes, timer_started_at=@timerStartedAt, rollover_count=@rolloverCount WHERE id=@id`,
  ).run({ ...next, deadlineTime: next.deadline ? next.deadlineTime : null, optionalInt: next.optional ? 1 : 0, steps: undefined });
  return next;
}

export const elapsedMinutes = (startIso: string) => Math.max(0, Math.round((currentInstant().getTime() - new Date(startIso).getTime()) / 60000));

// ---------- actual work sessions ----------

/** The timezone used to decide which day a session belongs to: the profile's, else the last one the app saw. */
export function sessionTimezone(db: DB): string {
  const row = db.prepare("SELECT data FROM profile WHERE id = 1").get() as { data: string } | undefined;
  const fromProfile = row ? (JSON.parse(row.data).timezone as string | undefined) : undefined;
  if (isValidTimeZone(fromProfile)) return fromProfile;
  const last = getSetting(db, "last_timezone");
  return isValidTimeZone(last) ? last : "UTC";
}

export interface SessionRow {
  id: string;
  taskId: string;
  date: string;
  startedAt: string | null;
  endedAt: string | null;
  minutes: number;
  source: "timer" | "reported" | "confirmed";
  blockStart: string | null;
  note: string | null;
  verified: boolean;
}

const SESSION_COLS =
  "id, task_id AS taskId, date, started_at AS startedAt, ended_at AS endedAt, minutes, source, block_start AS blockStart, note, verified";
const toSession = (r: Omit<SessionRow, "verified"> & { verified: number }): SessionRow => ({ ...r, verified: !!r.verified });

/** Keeps a task's running total of verified minutes in step with its sessions. */
export function adjustSpent(db: DB, taskId: string, delta: number) {
  if (!delta) return;
  db.prepare("UPDATE tasks SET spent_minutes = MAX(0, spent_minutes + ?) WHERE id = ?").run(Math.round(delta), taskId);
}

export function insertSession(
  db: DB,
  s: {
    taskId: string;
    date: string;
    minutes: number;
    source: SessionRow["source"];
    startedAt?: string | null;
    endedAt?: string | null;
    blockStart?: string | null;
    note?: string | null;
    verified?: boolean;
    /** Add the minutes to the task's total now (default). */
    adjust?: boolean;
  },
): SessionRow {
  const id = newId("ws");
  const verified = s.verified ?? true;
  db.prepare(
    "INSERT INTO work_sessions (id, task_id, date, started_at, ended_at, minutes, source, block_start, note, created_at, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, s.taskId, s.date, s.startedAt ?? null, s.endedAt ?? null, Math.round(s.minutes), s.source, s.blockStart ?? null, s.note ?? null, clockIso(), verified ? 1 : 0);
  if (verified && (s.adjust ?? true)) adjustSpent(db, s.taskId, s.minutes);
  return getSession(db, id)!;
}

export function getSession(db: DB, id: string): SessionRow | null {
  const r = db.prepare(`SELECT ${SESSION_COLS} FROM work_sessions WHERE id = ?`).get(id) as any;
  return r ? toSession(r) : null;
}

/** Changes a session's minutes and/or whether it is verified, keeping the task's total right. */
export function updateSession(db: DB, id: string, patch: { minutes?: number; verified?: boolean; note?: string | null }): SessionRow | null {
  const cur = getSession(db, id);
  if (!cur) return null;
  const minutes = patch.minutes != null ? Math.round(patch.minutes) : cur.minutes;
  const verified = patch.verified ?? cur.verified;
  adjustSpent(db, cur.taskId, (verified ? minutes : 0) - (cur.verified ? cur.minutes : 0));
  db.prepare("UPDATE work_sessions SET minutes = ?, verified = ?, note = ? WHERE id = ?").run(minutes, verified ? 1 : 0, patch.note !== undefined ? patch.note : cur.note, id);
  return getSession(db, id);
}

export function deleteSession(db: DB, id: string): boolean {
  const cur = getSession(db, id);
  if (!cur) return false;
  adjustSpent(db, cur.taskId, -(cur.verified ? cur.minutes : 0));
  db.prepare("DELETE FROM work_sessions WHERE id = ?").run(id);
  return true;
}

/** The note on uncertain timer time names why it needs a check ("needs-check:too_long"). */
export const NEEDS_CHECK = "needs-check:";

/**
 * Ends the running stretch of a task's timer and records it. Time the app can't vouch for (left running, another
 * device, across midnight…) is saved as "needs a check" and does NOT count toward the task's total until confirmed.
 * The caller updates the task row itself (clearing `timer_started_at`).
 */
export function recordTimerSession(db: DB, task: Task, opts: { verified?: boolean; minutes?: number; note?: string | null; doubt?: string | null } = {}): SessionRow | null {
  if (!task.timerStartedAt) return null;
  const elapsed = elapsedMinutes(task.timerStartedAt);
  const minutes = opts.minutes ?? elapsed;
  if (minutes < 1) return null;
  const tz = sessionTimezone(db);
  const doubt =
    opts.doubt !== undefined
      ? opts.doubt
      : assessTimer({
          startedAt: task.timerStartedAt,
          now: currentInstant(),
          estimateMinutes: task.estimateMinutes,
          tz,
          snoozeUntil: getSetting(db, `timer_snooze:${task.id}`),
        });
  const verified = opts.verified ?? !doubt;
  return insertSession(db, {
    taskId: task.id,
    date: localDateOf(task.timerStartedAt, tz),
    minutes,
    source: "timer",
    startedAt: task.timerStartedAt,
    endedAt: clockIso(),
    verified,
    note: opts.note !== undefined ? opts.note : !verified && doubt ? `${NEEDS_CHECK}${doubt}` : null,
    adjust: false,
  });
}

/** Work confirmed in the review for a planned block (not measured by the timer). */
export function addConfirmedSession(db: DB, s: { taskId: string; date: string; minutes: number; blockStart: string | null; note?: string | null }) {
  if (s.minutes < 1) return;
  insertSession(db, { taskId: s.taskId, date: s.date, minutes: s.minutes, source: "confirmed", blockStart: s.blockStart, note: s.note ?? null });
}

export function deleteConfirmedSessions(db: DB, taskId: string, date: string, blockStart: string) {
  const rows = db.prepare("SELECT id FROM work_sessions WHERE source = 'confirmed' AND task_id = ? AND date = ? AND block_start = ?").all(taskId, date, blockStart) as { id: string }[];
  for (const r of rows) deleteSession(db, r.id);
}

export function listSessions(db: DB, date: string): SessionRow[] {
  return (
    db.prepare(`SELECT ${SESSION_COLS} FROM work_sessions WHERE date = ? ORDER BY COALESCE(started_at, created_at)`).all(date) as any[]
  ).map(toSession);
}

/** Uncertain timer time waiting for the user to confirm or correct it (any day). */
export function listUnverifiedSessions(db: DB): SessionRow[] {
  return (db.prepare(`SELECT ${SESSION_COLS} FROM work_sessions WHERE verified = 0 ORDER BY created_at`).all() as any[]).map(toSession);
}

export function listSessionsForTask(db: DB, taskId: string): SessionRow[] {
  return (db.prepare(`SELECT ${SESSION_COLS} FROM work_sessions WHERE task_id = ? ORDER BY COALESCE(started_at, created_at)`).all(taskId) as any[]).map(toSession);
}

// ---------- outcomes of planned blocks ----------

export type BlockOutcomeValue = "done" | "partial" | "skipped" | "rescheduled";
export interface BlockOutcomeRow {
  date: string;
  taskId: string;
  start: string;
  outcome: BlockOutcomeValue;
  minutes: number | null;
  note: string | null;
}

export function recordBlockOutcome(db: DB, o: { date: string; taskId: string; start: string; outcome: BlockOutcomeValue; minutes?: number | null; note?: string | null }, overwrite = true) {
  const sql = overwrite
    ? "INSERT INTO block_outcomes (date, task_id, start, outcome, minutes, note, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(date, task_id, start) DO UPDATE SET outcome = excluded.outcome, minutes = excluded.minutes, note = excluded.note, decided_at = excluded.decided_at"
    : "INSERT OR IGNORE INTO block_outcomes (date, task_id, start, outcome, minutes, note, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
  db.prepare(sql).run(o.date, o.taskId, o.start, o.outcome, o.minutes ?? null, o.note ?? null, clockIso());
}

export function listBlockOutcomes(db: DB, date: string): BlockOutcomeRow[] {
  return db
    .prepare("SELECT date, task_id AS taskId, start, outcome, minutes, note FROM block_outcomes WHERE date = ?")
    .all(date) as BlockOutcomeRow[];
}

export function deleteTask(db: DB, id: string) {
  return db.prepare("UPDATE tasks SET deleted = 1, updated_at = ? WHERE id = ?").run(nowIso(), id).changes > 0;
}

// ---------- meetings ----------

const MEETING_COLS = "id, date, title, start, end, source, feed_id AS feedId";

export function listMeetings(db: DB, date: string): Meeting[] {
  return db
    .prepare(`SELECT ${MEETING_COLS} FROM meetings WHERE date = ? AND deleted = 0 ORDER BY start, end`)
    .all(date) as Meeting[];
}

export function listMeetingsBetween(db: DB, from: string, to: string): Meeting[] {
  return db
    .prepare(`SELECT ${MEETING_COLS} FROM meetings WHERE date >= ? AND date <= ? AND deleted = 0 ORDER BY date, start, end`)
    .all(from, to) as Meeting[];
}

export function createMeeting(db: DB, m: Omit<Meeting, "id"> & { id?: string }): Meeting {
  const meeting: Meeting = { id: m.id ?? newId("m"), date: m.date, title: m.title, start: m.start, end: m.end };
  db.prepare("INSERT INTO meetings (id, date, title, start, end, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    meeting.id,
    meeting.date,
    meeting.title,
    meeting.start,
    meeting.end,
    nowIso(),
  );
  return meeting;
}

export function updateMeeting(db: DB, id: string, patch: Partial<Omit<Meeting, "id">>) {
  const cur = db.prepare("SELECT id, date, title, start, end FROM meetings WHERE id = ? AND deleted = 0").get(id) as
    | Meeting
    | undefined;
  if (!cur) return null;
  const next = { ...cur, ...patch };
  db.prepare("UPDATE meetings SET title = ?, start = ?, end = ?, date = ? WHERE id = ?").run(next.title, next.start, next.end, next.date, id);
  return next;
}

export function deleteMeeting(db: DB, id: string) {
  return db.prepare("UPDATE meetings SET deleted = 1 WHERE id = ?").run(id).changes > 0;
}

// ---------- messages ----------

export function addMessage(db: DB, m: Omit<ChatMessage, "id" | "createdAt"> & { id?: string }): ChatMessage {
  const msg: ChatMessage = { id: m.id ?? newId("msg"), role: m.role, text: m.text, meta: m.meta ?? {}, createdAt: nowIso() };
  db.prepare("INSERT INTO messages (id, role, text, meta, created_at) VALUES (?, ?, ?, ?, ?)").run(
    msg.id,
    msg.role,
    msg.text,
    JSON.stringify(msg.meta),
    msg.createdAt,
  );
  return msg;
}

export function deleteMessage(db: DB, id: string) {
  db.prepare("DELETE FROM messages WHERE id = ?").run(id);
}

export function recentMessages(db: DB, limit: number): ChatMessage[] {
  const rows = db
    .prepare("SELECT id, role, text, meta, created_at FROM messages ORDER BY seq DESC LIMIT ?")
    .all(limit) as { id: string; role: ChatMessage["role"]; text: string; meta: string; created_at: string }[];
  return rows
    .reverse()
    .map((r) => ({ id: r.id, role: r.role, text: r.text, meta: JSON.parse(r.meta), createdAt: r.created_at }));
}

// ---------- proposals ----------

export function saveProposal(db: DB, p: Proposal) {
  db.prepare(
    `INSERT INTO proposals (id, created_at, status, date, kind, base_plan_version, data) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
  ).run(
    p.id,
    p.createdAt,
    p.status,
    p.date,
    p.kind,
    p.basePlanVersion,
    JSON.stringify({ plan: p.plan, taskChanges: p.taskChanges, contextSuggestions: p.contextSuggestions, warnings: p.warnings, projectPlan: p.projectPlan ?? null }),
  );
}

interface ProposalRow {
  id: string;
  created_at: string;
  status: Proposal["status"];
  date: string;
  kind: Proposal["kind"];
  base_plan_version: number;
  data: string;
}

const rowToProposal = (r: ProposalRow): Proposal => ({
  id: r.id,
  createdAt: r.created_at,
  status: r.status,
  date: r.date,
  kind: r.kind,
  basePlanVersion: r.base_plan_version,
  ...JSON.parse(r.data),
});

export function getProposal(db: DB, id: string): Proposal | null {
  const r = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as ProposalRow | undefined;
  return r ? rowToProposal(r) : null;
}

export function latestPendingProposal(db: DB): Proposal | null {
  const r = db
    .prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get() as ProposalRow | undefined;
  return r ? rowToProposal(r) : null;
}

export function supersedePending(db: DB) {
  db.prepare("UPDATE proposals SET status = 'superseded' WHERE status = 'pending'").run();
}

export function setProposalStatus(db: DB, id: string, status: Proposal["status"]) {
  db.prepare("UPDATE proposals SET status = ? WHERE id = ?").run(status, id);
}

// ---------- plans ----------

interface PlanRow {
  id: string;
  date: string;
  version: number;
  status: Plan["status"];
  data: string;
  created_at: string;
  proposal_id: string | null;
  source: Plan["source"];
}

function loadPlan(db: DB, r: PlanRow): Plan {
  const blocks = (
    db
      .prepare("SELECT id, start, end, kind, task_id, meeting_id, title, pinned, provisional FROM plan_blocks WHERE plan_id = ? ORDER BY position")
      .all(r.id) as { id: string; start: string; end: string; kind: PlanBlock["kind"]; task_id: string | null; meeting_id: string | null; title: string; pinned: number; provisional: number }[]
  ).map((b) => ({
    id: b.id,
    start: b.start,
    end: b.end,
    kind: b.kind,
    taskId: b.task_id,
    meetingId: b.meeting_id,
    title: b.title,
    ...(b.pinned ? { pinned: true } : {}),
    ...(b.provisional ? { provisional: true } : {}),
  }));
  return {
    ...JSON.parse(r.data),
    id: r.id,
    date: r.date,
    version: r.version,
    status: r.status,
    createdAt: r.created_at,
    proposalId: r.proposal_id,
    source: r.source,
    blocks,
  };
}

export function currentPlan(db: DB, date: string): Plan | null {
  const r = db
    .prepare("SELECT * FROM plans WHERE date = ? AND status = 'confirmed' ORDER BY version DESC LIMIT 1")
    .get(date) as PlanRow | undefined;
  return r ? loadPlan(db, r) : null;
}

export function currentPlanVersion(db: DB, date: string): number {
  const r = db.prepare("SELECT MAX(version) AS v FROM plans WHERE date = ?").get(date) as { v: number | null };
  return r.v ?? 0;
}

export function planVersions(db: DB, date: string) {
  return (
    db.prepare("SELECT version, created_at, source FROM plans WHERE date = ? ORDER BY version").all(date) as {
      version: number;
      created_at: string;
      source: string;
    }[]
  ).map((r) => ({ version: r.version, createdAt: r.created_at, source: r.source }));
}

export function latestPlanBefore(db: DB, date: string): Plan | null {
  const r = db
    .prepare("SELECT * FROM plans WHERE date < ? AND status = 'confirmed' ORDER BY date DESC, version DESC LIMIT 1")
    .get(date) as PlanRow | undefined;
  return r ? loadPlan(db, r) : null;
}

/**
 * Saves a new confirmed plan version for draft.date. Throws StalePlanError if
 * the latest version is not `expectedVersion` (someone else changed the plan).
 */
export class StalePlanError extends Error {
  constructor(public current: number) {
    super("The plan changed since this proposal was made.");
  }
}

export function savePlanVersion(
  db: DB,
  draft: PlanDraft,
  opts: { expectedVersion: number; proposalId: string | null; source: Plan["source"] },
): Plan {
  return db.transaction(() => {
    const cur = currentPlanVersion(db, draft.date);
    if (cur !== opts.expectedVersion) throw new StalePlanError(cur);
    db.prepare("UPDATE plans SET status = 'superseded' WHERE date = ? AND status = 'confirmed'").run(draft.date);
    const id = newId("p");
    const { blocks, ...rest } = draft;
    const createdAt = clockIso();
    db.prepare(
      "INSERT INTO plans (id, date, version, status, data, created_at, proposal_id, source) VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?)",
    ).run(id, draft.date, cur + 1, JSON.stringify(rest), createdAt, opts.proposalId, opts.source);
    const ins = db.prepare(
      "INSERT INTO plan_blocks (plan_id, id, position, start, end, kind, task_id, meeting_id, title, pinned, provisional) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    blocks.forEach((b, i) => ins.run(id, b.id, i, b.start, b.end, b.kind, b.taskId, b.meetingId, b.title, b.pinned ? 1 : 0, b.provisional ? 1 : 0));
    return currentPlan(db, draft.date)!;
  })();
}

// ---------- idempotency ----------

export function beginRequest(db: DB, id: string): { state: "new" } | { state: "running" } | { state: "done"; response: unknown } {
  const r = db.prepare("SELECT status, response FROM requests WHERE id = ?").get(id) as
    | { status: string; response: string | null }
    | undefined;
  if (r) {
    if (r.status === "done" && r.response) return { state: "done", response: JSON.parse(r.response) };
    if (r.status === "running") return { state: "running" };
    // failed earlier: allow a retry with the same id
    db.prepare("UPDATE requests SET status = 'running', created_at = ? WHERE id = ?").run(nowIso(), id);
    return { state: "new" };
  }
  db.prepare("INSERT INTO requests (id, created_at, status) VALUES (?, ?, 'running')").run(id, nowIso());
  return { state: "new" };
}

export function finishRequest(db: DB, id: string, ok: boolean, response?: unknown) {
  db.prepare("UPDATE requests SET status = ?, response = ? WHERE id = ?").run(
    ok ? "done" : "failed",
    ok ? JSON.stringify(response ?? null) : null,
    id,
  );
}

/** Marks requests left "running" by a crash as failed so they can be retried. */
export function recoverRequests(db: DB) {
  db.prepare("UPDATE requests SET status = 'failed' WHERE status = 'running'").run();
}

// ---------- settings ----------

export function getSetting(db: DB, key: string): string | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
