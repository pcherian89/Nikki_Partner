import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Isolated temp database + no API key, set BEFORE the app is imported.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-history-"));
process.env.DATABASE_PATH = path.join(tmp, "nikki.db");
process.env.ANTHROPIC_API_KEY = "";
process.env.NIKKI_FAKE_NOW = "2026-10-21T10:00:00Z";

const { app } = await import("../index.js");
const { setProvider } = await import("../provider/index.js");
const { getDb, wipe, createTask, savePlanVersion } = await import("../db.js");
const { dayHistory } = await import("../history.js");
const { SCHEMA_VERSION } = await import("../db.js");

const DAY = "2026-10-21";
const TZ = "UTC";
let server: Server;
let base = "";
let rid = 0;
const at = (hhmm: string, day = DAY) => (process.env.NIKKI_FAKE_NOW = `${day}T${hhmm}:00Z`);

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  wipe(getDb("personal"));
  setProvider(null);
  at("10:00");
});

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json", "x-workspace": "personal", "x-timezone": TZ },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
const db = () => getDb("personal");
const state = async () => (await api("GET", "/api/state")).json.state;

type B = { start: string; end: string; kind?: "focus" | "task" | "break" | "buffer"; task?: string; title?: string };
/** Saves a confirmed plan version directly (as if the user had confirmed it at the current fake time). */
function savePlan(blocks: B[], budget = 360, window = { start: "09:00", end: "17:30" }, focus: string | null = null) {
  const version = (db().prepare("SELECT MAX(version) AS v FROM plans WHERE date = ?").get(DAY) as { v: number | null }).v ?? 0;
  return savePlanVersion(
    db(),
    {
      date: DAY,
      mainOutcome: "",
      focusTaskId: focus,
      focusWhy: "",
      supporting: [],
      deferred: [],
      reasons: [],
      assumptions: [],
      window,
      workBudgetMinutes: budget,
      blocks: blocks.map((b, i) => ({
        id: `b${version}_${i}`,
        start: b.start,
        end: b.end,
        kind: b.kind ?? (b.task ? "task" : "break"),
        taskId: b.task ?? null,
        meetingId: null,
        title: b.title ?? "x",
      })),
    },
    { expectedVersion: version, proposalId: null, source: "user-edit" },
  );
}
const task = (title: string, extra: Record<string, unknown> = {}) => createTask(db(), { title, estimateMinutes: 60, ...extra }).id;

// ---------- the two confirmed bugs ----------

const empty = { questions: [], quick_replies: [], captured_items: [], task_updates: [], meetings: [], context_updates: [], plan: null };
const planOf = (budget: number, focus: string, blocks: any[]) => ({
  date: DAY,
  main_outcome: "Day",
  focus: { task_ref: focus, why: "" },
  supporting: [],
  deferred: [],
  window: { start: "10:00", end: "17:30" },
  work_budget_minutes: budget,
  blocks,
  reasons: [],
  assumptions: [],
});
function replanWith(ids: { presentation: string; report: string }, budget: number, blocks: any[]) {
  setProvider({
    name: "fake",
    model: "fake",
    generate: async () => ({ model: "fake", text: JSON.stringify({ ...empty, message: "replanned", plan: planOf(budget, ids.presentation, blocks) }) }),
  });
}
const workBlocks = (plan: any) => plan.blocks.filter((b: any) => b.kind === "focus" || b.kind === "task").map((b: any) => `${b.start}-${b.end} ${b.title}`);

test("bug 1: replanning in the middle of a block keeps that block", async () => {
  const presentation = task("Medical presentation", { estimateMinutes: 210 });
  const report = task("KSN report", { estimateMinutes: 120 });
  savePlan(
    [
      { start: "10:00", end: "11:30", kind: "focus", task: presentation, title: "Medical presentation" },
      { start: "11:30", end: "13:30", task: report, title: "KSN report" },
    ],
    210,
    { start: "10:00", end: "17:30" },
    presentation,
  );
  at("11:29"); // the 10:00–11:30 block has begun but not ended
  replanWith({ presentation, report }, 450, [
    { start: "11:30", end: "13:30", kind: "task", task_ref: report, title: "KSN report" },
    { start: "13:30", end: "15:00", kind: "focus", task_ref: presentation, title: "Medical presentation" },
  ]);
  const r = await api("POST", "/api/messages", { text: "Move the presentation to 1:30 and the report to now", clientRequestId: `rid-${++rid}-aaaaaaaa` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const c = await api("POST", `/api/proposals/${r.json.state.proposal.id}/confirm`, {});
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual(workBlocks(c.json.state.plan), ["10:00-11:30 Medical presentation", "11:30-13:30 KSN report", "13:30-15:00 Medical presentation"]);
  // and it is not hiding: it is in the day's record as not yet confirmed
  assert.deepEqual(c.json.state.history, [], "it is still running, so it isn't 'not recorded' yet");
});

test("bug 1b: a started block that overlaps the new plan is cut back to where the new plan starts, not dropped", async () => {
  const presentation = task("Medical presentation");
  const report = task("KSN report");
  savePlan([{ start: "10:00", end: "11:30", kind: "focus", task: presentation, title: "Medical presentation" }], 90, { start: "10:00", end: "17:30" }, presentation);
  at("11:29");
  replanWith({ presentation, report }, 450, [{ start: "11:25", end: "13:25", kind: "task", task_ref: report, title: "KSN report" }]); // within the 10-minute grace
  const r = await api("POST", "/api/messages", { text: "Replan: report now", clientRequestId: `rid-${++rid}-bbbbbbbb` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const c = await api("POST", `/api/proposals/${r.json.state.proposal.id}/confirm`, {});
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual(workBlocks(c.json.state.plan), ["10:00-11:25 Medical presentation", "11:25-13:25 KSN report"]);
});

test("bug 2: replanning after work was already done no longer fails with a budget error", async () => {
  const presentation = task("Medical presentation");
  const report = task("KSN report");
  savePlan(
    [
      { start: "10:00", end: "11:00", kind: "focus", task: presentation, title: "Medical presentation" },
      { start: "11:00", end: "13:00", task: report, title: "KSN report" },
    ],
    180,
    { start: "10:00", end: "17:30" },
    presentation,
  );
  at("11:29");
  // The model reports the whole free time as its budget (what it is asked for); the app used to add the finished hour on top.
  replanWith({ presentation, report }, 450, [
    { start: "11:30", end: "13:30", kind: "task", task_ref: report, title: "KSN report" },
    { start: "13:30", end: "15:00", kind: "focus", task_ref: presentation, title: "Medical presentation" },
  ]);
  const r = await api("POST", "/api/messages", { text: "replan", clientRequestId: `rid-${++rid}-cccccccc` });
  const c = await api("POST", `/api/proposals/${r.json.state.proposal.id}/confirm`, {});
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const plan = c.json.state.plan;
  const work = plan.blocks.filter((b: any) => b.kind === "focus" || b.kind === "task").reduce((s: number, b: any) => s + (Number(b.end.slice(0, 2)) * 60 + Number(b.end.slice(3))) - (Number(b.start.slice(0, 2)) * 60 + Number(b.start.slice(3))), 0);
  assert.ok(plan.workBudgetMinutes >= work && plan.workBudgetMinutes <= 450, `budget ${plan.workBudgetMinutes} follows the blocks (${work} min) and stays within the free time`);
});

test("a start time a minute in the past is accepted (chat edits have a few minutes' grace)", async () => {
  const a = task("KSUM presentation");
  const b = task("KSN final report");
  savePlan([{ start: "15:30", end: "17:30", kind: "task", task: b, title: "KSN final report" }], 120, { start: "10:00", end: "17:30" }, b);
  at("14:31");
  setProvider({
    name: "fake",
    model: "fake",
    generate: async () => ({
      model: "fake",
      text: JSON.stringify({
        ...empty,
        message: "ok",
        plan: planOf(210, a, [
          { start: "14:30", end: "16:00", kind: "focus", task_ref: a, title: "KSUM presentation" },
          { start: "16:00", end: "17:30", kind: "task", task_ref: b, title: "KSN final report" },
        ]),
      }),
    }),
  });
  const r = await api("POST", "/api/messages", { text: "2:30-4 work on KSUM presentation", clientRequestId: `rid-${++rid}-dddddddd` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.state.proposal?.plan, "a proposal was made, not rejected for starting at 2:30");
  assert.equal(r.json.state.proposal.plan.blocks.find((x: any) => x.title === "KSUM presentation").start, "14:30");
});

// ---------- daily history ----------

test("history: a block dropped by an older version of the plan can be recovered from the plan versions", async () => {
  const a = task("Medical presentation");
  const b = task("KSN report");
  at("10:00");
  savePlan([
    { start: "10:00", end: "11:30", kind: "focus", task: a, title: "Medical presentation" },
    { start: "11:30", end: "13:30", task: b, title: "KSN report" },
  ]);
  at("11:29");
  // What the old behaviour produced: version 2 simply lacks the 10:00 block.
  savePlan([
    { start: "11:30", end: "13:30", task: b, title: "KSN report" },
    { start: "13:30", end: "15:00", kind: "focus", task: a, title: "Medical presentation" },
  ]);
  const items = dayHistory(db(), DAY, TZ, { date: DAY, time: "11:29" });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Medical presentation");
  assert.equal(`${items[0].start}-${items[0].end}`, "10:00-11:30");
  assert.equal(items[0].status, "unconfirmed", "it had begun; nobody said what happened, so it is not assumed done or skipped");
  assert.equal(items[0].inCurrentPlan, false);
  // The same answer over the API, which is what the app shows.
  assert.equal((await state()).history[0].title, "Medical presentation");
  // Both plan versions are still stored.
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM plans WHERE date = ?").get(DAY) as { n: number }).n, 2);
});

test("history: time passing alone never marks anything done, skipped or moved", async () => {
  const a = task("Write the report");
  savePlan([{ start: "10:00", end: "11:00", kind: "focus", task: a, title: "Write the report" }]);
  at("17:00");
  const s = await state();
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].status, "unconfirmed");
  assert.equal(s.tasks.find((t: any) => t.id === a).status, "open");
  // Next day it is still waiting for an answer
  at("09:00", "2026-10-22");
  const old = await api("GET", `/api/history?date=${DAY}`);
  assert.equal(old.json.items[0].status, "unconfirmed");
});

test("history: finishing the task does not mark earlier blocks done; only later ones become not needed", async () => {
  const a = task("Medical presentation");
  savePlan([
    { start: "10:00", end: "11:00", kind: "focus", task: a, title: "Medical presentation" },
    { start: "14:00", end: "15:00", task: a, title: "Medical presentation" },
  ]);
  at("12:00");
  await api("PATCH", `/api/tasks/${a}`, { status: "done" });
  const items = (await state()).history.map((h: any) => `${h.start} ${h.status}`);
  assert.deepEqual(items, ["10:00 unconfirmed", "14:00 replaced"]);
});

test("history: a task can have several sessions on one day, each kept", async () => {
  const a = task("Medical presentation", { estimateMinutes: 210 });
  savePlan([
    { start: "10:00", end: "11:30", kind: "focus", task: a, title: "Medical presentation" },
    { start: "13:30", end: "14:30", task: a, title: "Medical presentation" },
  ]);
  at("10:05");
  await api("POST", `/api/tasks/${a}/timer`, { action: "start" });
  at("10:25");
  await api("POST", `/api/tasks/${a}/timer`, { action: "stop" }); // paused: 20 min
  at("10:40");
  await api("POST", `/api/tasks/${a}/timer`, { action: "start" });
  at("10:55");
  await api("POST", `/api/tasks/${a}/timer`, { action: "stop" }); // 15 min
  at("13:35");
  await api("POST", `/api/tasks/${a}/timer`, { action: "start" });
  at("13:45");
  await api("PATCH", `/api/tasks/${a}`, { status: "done" }); // finishing stops the timer: 10 min
  const s = await state();
  assert.deepEqual(s.sessions.map((x: any) => x.minutes), [20, 15, 10]);
  assert.ok(s.sessions.every((x: any) => x.source === "timer" && x.date === DAY));
  const t = s.tasks.find((x: any) => x.id === a);
  assert.equal(t.spentMinutes, 45, "the task's running total still matches");
  assert.equal(t.status, "done", "one overall status for the task");
});

test("outcomes: the user's answer is recorded per block and is separate from the task's status", async () => {
  const a = task("Medical presentation");
  const b = task("KSN report");
  const c = task("Apply for jobs");
  savePlan([
    { start: "10:00", end: "11:00", kind: "focus", task: a, title: "Medical presentation" },
    { start: "11:00", end: "12:00", task: b, title: "KSN report" },
    { start: "12:00", end: "13:00", task: c, title: "Apply for jobs" },
  ]);
  at("11:05");
  await api("POST", `/api/tasks/${b}/timer`, { action: "start" });
  at("11:35");
  await api("POST", `/api/tasks/${b}/timer`, { action: "stop" }); // 30 min of timer work on B
  at("17:00");
  const r = await api("POST", "/api/history/outcome", {
    outcomes: [
      { taskId: a, start: "10:00", outcome: "done" }, // no timer: confirms the planned hour
      { taskId: b, start: "11:00", outcome: "partial" }, // timer already recorded 30 min: nothing added
      { taskId: c, start: "12:00", outcome: "skipped" },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = r.json.state;
  const byKey = Object.fromEntries(s.history.map((h: any) => [h.taskId, h]));
  assert.equal(byKey[a].status, "done");
  assert.equal(byKey[a].recorded, true);
  assert.equal(byKey[b].status, "partial");
  assert.equal(byKey[c].status, "skipped");
  const confirmed = s.sessions.filter((x: any) => x.source === "confirmed");
  assert.deepEqual(confirmed.map((x: any) => [x.taskId, x.minutes]), [[a, 60]]);
  assert.equal(byKey[b].workedMinutes, 30, "actual time for B is the timer's 30, not the planned hour");
  assert.ok(s.tasks.every((t: any) => t.status === "open"), "recording what happened in a block never completes a task");
  // Changing an answer replaces the time it confirmed instead of adding to it
  const again = await api("POST", "/api/history/outcome", { outcomes: [{ taskId: a, start: "10:00", outcome: "partial", minutes: 25 }] });
  const sessions = again.json.state.sessions.filter((x: any) => x.taskId === a);
  assert.deepEqual(sessions.map((x: any) => x.minutes), [25]);
  // Unknown blocks are refused
  assert.equal((await api("POST", "/api/history/outcome", { outcomes: [{ taskId: a, start: "09:15", outcome: "done" }] })).status, 404);
});

test("rescheduling: a move you make records that block as rescheduled; blocks still ahead are never lost either", async () => {
  const a = task("Tender pack");
  const b = task("Sports night poster");
  const c = task("Playbook");
  savePlan([
    { start: "10:00", end: "11:00", kind: "focus", task: a, title: "Tender pack" },
    { start: "11:00", end: "12:00", task: b, title: "Sports night poster" },
    { start: "14:00", end: "15:00", task: c, title: "Playbook" },
  ]);
  at("11:30");
  const m1 = await api("POST", `/api/tasks/${a}/reschedule`, { to: "date", date: "2026-10-22" });
  assert.equal(m1.status, 200, JSON.stringify(m1.json));
  const m2 = await api("POST", `/api/tasks/${c}/reschedule`, { to: "someday" });
  assert.equal(m2.status, 200, JSON.stringify(m2.json));
  const s = await state();
  const h = Object.fromEntries(s.history.map((x: any) => [x.taskId, x]));
  assert.equal(h[a].status, "rescheduled");
  assert.equal(h[a].recorded, true);
  assert.match(h[a].note, /2026-10-22/);
  assert.equal(h[c].status, "rescheduled", "removed before it began");
  assert.equal(h[c].recorded, false);
  assert.ok(!s.plan.blocks.some((x: any) => x.taskId === a || x.taskId === c), "off today's plan");
  // The day-end review's own decisions don't answer for blocks: B stays "not recorded" until the user says what happened.
  at("17:00");
  const w = await api("POST", "/api/wrapup", { decisions: [{ taskId: b, action: "tomorrow" }], note: "" });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  const b2 = w.json.state.history.find((x: any) => x.taskId === b);
  assert.equal(b2.status, "unconfirmed");
  assert.equal(w.json.state.tasks.find((t: any) => t.id === b).plannedDate, "2026-10-22");
});

// ---------- data safety ----------

test("export and import carry sessions and outcomes", async () => {
  const a = task("Medical presentation");
  savePlan([{ start: "10:00", end: "11:00", kind: "focus", task: a, title: "Medical presentation" }]);
  at("12:00");
  await api("POST", "/api/history/outcome", { outcomes: [{ taskId: a, start: "10:00", outcome: "done" }] });
  const dump = (await api("GET", "/api/export")).json;
  assert.equal(dump.work_sessions.length, 1);
  assert.equal(dump.block_outcomes.length, 1);
  await api("DELETE", "/api/data", { confirm: "DELETE" });
  assert.equal((await state()).history.length, 0);
  const back = await api("POST", "/api/import", { confirm: "REPLACE", data: dump });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(back.json.state.history[0].status, "done");
  assert.equal(back.json.state.sessions.length, 1);
});

test("migration: an existing database is copied aside first and its data is untouched", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-migrate-"));
  const file = path.join(dir, "nikki.db");
  const script = (body: string) =>
    execFileSync("node", ["--import", "tsx", "--input-type=module", "-e", body], {
      cwd: path.resolve("."),
      env: { ...process.env, DATABASE_PATH: file, ANTHROPIC_API_KEY: "", NIKKI_FAKE_NOW: "" },
      encoding: "utf8",
    });
  try {
    // 1. Make a database that looks like the previous release: has data, no new tables, user_version 0.
    script(`
      const { getDb, createTask } = await import("./server/db.ts");
      const db = getDb("personal");
      createTask(db, { title: "Existing task" });
      db.exec("DROP TABLE work_sessions; DROP TABLE block_outcomes; PRAGMA user_version = 0;");
    `);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".bak")), [], "a brand-new database needs no copy");
    // 2. Start the new release on it.
    const out = script(`
      const { getDb } = await import("./server/db.ts");
      const db = getDb("personal");
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      console.log(JSON.stringify({ version: db.pragma("user_version", { simple: true }), tables, titles: db.prepare("SELECT title FROM tasks").all().map((r) => r.title) }));
    `);
    const info = JSON.parse(out.trim().split("\n").pop()!);
    assert.equal(info.version, SCHEMA_VERSION);
    for (const t of ["work_sessions", "block_outcomes", "reminders", "projects", "milestones", "memory_items", "push_subscriptions", "secrets"]) assert.ok(info.tables.includes(t), `table ${t} added`);
    assert.deepEqual(info.titles, ["Existing task"], "existing tasks survive");
    const baks = fs.readdirSync(dir).filter((f) => f.endsWith(".bak"));
    assert.equal(baks.length, 1, "one copy was taken before the upgrade");
    // 3. The copy is a complete, readable database in the OLD layout — what a rollback would restore.
    const check = execFileSync(
      "node",
      ["-e", `const D=require("better-sqlite3");const d=new D(${JSON.stringify(path.join(dir, baks[0]))},{readonly:true});console.log(JSON.stringify({t:d.prepare("SELECT title FROM tasks").all(),n:d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='work_sessions'").get().c}))`],
      { cwd: path.resolve("."), encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(check.trim()), { t: [{ title: "Existing task" }], n: 0 });
    // 4. Starting again changes nothing and takes no second copy.
    script(`const { getDb } = await import("./server/db.ts"); getDb("personal");`);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".bak")).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history: actual time is attached to the block it happened in, not repeated on every block of the task", async () => {
  const a = task("Medical presentation");
  savePlan([
    { start: "10:00", end: "11:30", kind: "focus", task: a, title: "Medical presentation" },
    { start: "13:30", end: "14:30", task: a, title: "Medical presentation" },
  ]);
  at("10:10");
  await api("POST", `/api/tasks/${a}/timer`, { action: "start" });
  at("10:50");
  await api("POST", `/api/tasks/${a}/timer`, { action: "stop" }); // 40 min in the morning block
  at("13:35");
  await api("POST", `/api/tasks/${a}/timer`, { action: "start" });
  at("14:05");
  await api("POST", `/api/tasks/${a}/timer`, { action: "stop" }); // 30 min in the afternoon block
  at("17:00");
  const h = Object.fromEntries((await state()).history.map((x: any) => [x.start, x.workedMinutes]));
  assert.deepEqual(h, { "10:00": 40, "13:30": 30 });
});
