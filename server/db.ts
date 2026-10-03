import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type {
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
CREATE TABLE IF NOT EXISTS settings (
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
  db.exec(SCHEMA);
  dbs.set(ws, db);
  return db;
}

/** Wipes every table in a workspace (used for Reset demo / Delete my data). */
export function wipe(db: DB) {
  db.transaction(() => {
    for (const t of ["profile", "tasks", "messages", "meetings", "proposals", "plans", "plan_blocks", "requests", "settings"]) {
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

export function saveProfile(db: DB, profile: Profile) {
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
}

const rowToTask = (r: TaskRow): Task => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  type: r.type,
  status: r.status,
  estimateMinutes: r.estimate_minutes,
  deadline: r.deadline,
  project: r.project,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
  source: r.source,
});

export function listTasks(db: DB): Task[] {
  return (db.prepare("SELECT * FROM tasks WHERE deleted = 0 ORDER BY created_at, rowid").all() as TaskRow[]).map(
    rowToTask,
  );
}

export function getTask(db: DB, id: string): Task | null {
  const r = db.prepare("SELECT * FROM tasks WHERE id = ? AND deleted = 0").get(id) as TaskRow | undefined;
  return r ? rowToTask(r) : null;
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
    project: t.project ?? null,
    createdAt: ts,
    updatedAt: ts,
    completedAt: t.status === "done" ? ts : null,
    source: t.source ?? "user",
  };
  if (t.createdAt) task.createdAt = task.updatedAt = t.createdAt;
  db.prepare(
    `INSERT INTO tasks (id, title, notes, type, status, estimate_minutes, deadline, project, created_at, updated_at, completed_at, source)
     VALUES (@id, @title, @notes, @type, @status, @estimateMinutes, @deadline, @project, @createdAt, @updatedAt, @completedAt, @source)`,
  ).run(task);
  return task;
}

export function updateTask(db: DB, id: string, patch: Partial<Task>): Task | null {
  const cur = getTask(db, id);
  if (!cur) return null;
  const next: Task = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, updatedAt: nowIso() };
  if (patch.status && patch.status !== cur.status) {
    next.completedAt = patch.status === "done" ? nowIso() : null;
  }
  db.prepare(
    `UPDATE tasks SET title=@title, notes=@notes, type=@type, status=@status, estimate_minutes=@estimateMinutes,
     deadline=@deadline, project=@project, updated_at=@updatedAt, completed_at=@completedAt WHERE id=@id`,
  ).run(next);
  return next;
}

export function deleteTask(db: DB, id: string) {
  return db.prepare("UPDATE tasks SET deleted = 1, updated_at = ? WHERE id = ?").run(nowIso(), id).changes > 0;
}

// ---------- meetings ----------

export function listMeetings(db: DB, date: string): Meeting[] {
  return db
    .prepare("SELECT id, date, title, start, end FROM meetings WHERE date = ? AND deleted = 0 ORDER BY start")
    .all(date) as Meeting[];
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

export function updateMeeting(db: DB, id: string, patch: Partial<Omit<Meeting, "id" | "date">>) {
  const cur = db.prepare("SELECT id, date, title, start, end FROM meetings WHERE id = ? AND deleted = 0").get(id) as
    | Meeting
    | undefined;
  if (!cur) return null;
  const next = { ...cur, ...patch };
  db.prepare("UPDATE meetings SET title = ?, start = ?, end = ? WHERE id = ?").run(next.title, next.start, next.end, id);
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
    JSON.stringify({ plan: p.plan, taskChanges: p.taskChanges, contextSuggestions: p.contextSuggestions, warnings: p.warnings }),
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
      .prepare("SELECT id, start, end, kind, task_id, meeting_id, title FROM plan_blocks WHERE plan_id = ? ORDER BY position")
      .all(r.id) as { id: string; start: string; end: string; kind: PlanBlock["kind"]; task_id: string | null; meeting_id: string | null; title: string }[]
  ).map((b) => ({ id: b.id, start: b.start, end: b.end, kind: b.kind, taskId: b.task_id, meetingId: b.meeting_id, title: b.title }));
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
    const createdAt = nowIso();
    db.prepare(
      "INSERT INTO plans (id, date, version, status, data, created_at, proposal_id, source) VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?)",
    ).run(id, draft.date, cur + 1, JSON.stringify(rest), createdAt, opts.proposalId, opts.source);
    const ins = db.prepare(
      "INSERT INTO plan_blocks (plan_id, id, position, start, end, kind, task_id, meeting_id, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    blocks.forEach((b, i) => ins.run(id, b.id, i, b.start, b.end, b.kind, b.taskId, b.meetingId, b.title));
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
