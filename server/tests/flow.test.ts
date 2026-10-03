import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Isolated temp database + no API key, set BEFORE the app is imported.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-test-"));
process.env.DATABASE_PATH = path.join(tmp, "nikki.db");
process.env.ANTHROPIC_API_KEY = "";
process.env.NIKKI_FAKE_NOW = "2026-10-05T08:00:00Z"; // 09:00 in Europe/London (BST)

const { app } = await import("../index.js");
const { setProvider } = await import("../provider/index.js");
const { ProviderError } = await import("../provider/types.js");
const { EXAMPLE_DUMP } = await import("../demo.js");
const { validatePlanDraft, workMinutes } = await import("../validate.js");
const { localNow } = await import("../time.js");
const { getDb, wipe } = await import("../db.js");

const TZ = "Europe/London";
let server: Server;
let base = "";
let rid = 0;

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
  wipe(getDb("demo"));
  wipe(getDb("personal"));
  setProvider(null);
  process.env.NIKKI_FAKE_NOW = "2026-10-05T08:00:00Z";
});

async function api(method: string, url: string, body?: unknown, ws = "demo") {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json", "x-workspace": ws, "x-timezone": TZ },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
const send = (text: string, ws = "demo", id = `req-${++rid}-xxxxxxxx`) => api("POST", "/api/messages", { text, clientRequestId: id }, ws);

async function demoPlan() {
  const r1 = await send(EXAMPLE_DUMP);
  assert.equal(r1.status, 200);
  const last = r1.json.state.messages.at(-1);
  const r2 = await send(last.meta.exampleAnswer);
  assert.equal(r2.status, 200);
  return r2.json.state;
}

test("demo: capture -> clarify asks at most two questions and separates actions/ideas/meetings", async () => {
  const r = await send(EXAMPLE_DUMP);
  assert.equal(r.status, 200);
  const s = r.json.state;
  const msg = s.messages.at(-1);
  assert.equal(msg.role, "assistant");
  assert.equal(msg.meta.demo, true);
  assert.ok(msg.meta.questions.length >= 1 && msg.meta.questions.length <= 2);
  assert.match(msg.meta.questions[0], /exclude the 14:00–16:00 meeting/);
  const actions = s.tasks.filter((t: any) => t.type === "action").map((t: any) => t.title);
  const ideas = s.tasks.filter((t: any) => t.type === "idea").map((t: any) => t.title);
  assert.deepEqual(actions, ["Finish a proposal", "Review beta feedback", "Apply for jobs"]);
  assert.deepEqual(ideas, ["Explore a business idea"]);
  assert.equal(s.meetings.length, 1);
  assert.equal(s.meetings[0].start, "14:00");
  assert.equal(s.plan, null);
});

test("demo: propose -> confirm produces a valid plan within the budget, around the meeting", async () => {
  const s = await demoPlan();
  const p = s.proposal;
  assert.ok(p?.plan, "proposal has a plan");
  const plan = p.plan;
  assert.equal(plan.window.start, "10:00");
  assert.equal(plan.window.end, "17:00");
  assert.equal(plan.workBudgetMinutes, 300);
  assert.ok(workMinutes(plan) <= 300);
  assert.ok(plan.supporting.length <= 2);
  const focus = s.tasks.find((t: any) => t.id === plan.focusTaskId);
  assert.equal(focus.title, "Finish a proposal");
  assert.ok(plan.blocks.some((b: any) => b.kind === "meeting" && b.start === "14:00" && b.end === "16:00"));
  assert.ok(plan.blocks.some((b: any) => b.kind === "break"));
  assert.ok(plan.blocks.some((b: any) => b.kind === "buffer"));
  const idea = s.tasks.find((t: any) => t.type === "idea");
  assert.ok(plan.deferred.some((d: any) => d.taskId === idea.id));

  const c = await api("POST", `/api/proposals/${p.id}/confirm`, {});
  assert.equal(c.status, 200);
  assert.equal(c.json.state.plan.version, 1);
  assert.equal(c.json.state.proposal, null);
  // confirming twice is idempotent
  const again = await api("POST", `/api/proposals/${p.id}/confirm`, {});
  assert.equal(again.json.alreadyConfirmed, true);
  assert.equal(again.json.state.plan.version, 1);
});

test("completion and undo persist without a model call", async () => {
  const s = await demoPlan();
  await api("POST", `/api/proposals/${s.proposal.id}/confirm`, {});
  const focusId = s.proposal.plan.focusTaskId;
  const msgCount = s.messages.length;
  const done = await api("PATCH", `/api/tasks/${focusId}`, { status: "done" });
  assert.equal(done.json.task.status, "done");
  assert.ok(done.json.task.completedAt);
  assert.equal(done.json.state.messages.length, msgCount);
  const undo = await api("PATCH", `/api/tasks/${focusId}`, { status: "open" });
  assert.equal(undo.json.task.status, "open");
  assert.equal(undo.json.task.completedAt, null);
  const reload = await api("GET", "/api/state");
  assert.equal(reload.json.state.tasks.find((t: any) => t.id === focusId).status, "open");
});

test("replan keeps completed work and meetings, only schedules from now, no duplicates", async () => {
  const s = await demoPlan();
  await api("POST", `/api/proposals/${s.proposal.id}/confirm`, {});
  const focusId = s.proposal.plan.focusTaskId;
  await api("PATCH", `/api/tasks/${focusId}`, { status: "done" });
  process.env.NIKKI_FAKE_NOW = "2026-10-05T11:20:00Z"; // 12:20 London
  const taskCount = (await api("GET", "/api/state")).json.state.tasks.length;
  const r = await api("POST", "/api/replan", { clientRequestId: "replan-1-xxxxxxxx", remainingUntil: "17:00" });
  assert.equal(r.status, 200);
  const p = r.json.state.proposal;
  assert.equal(p.kind, "replan");
  for (const b of p.plan.blocks.filter((b: any) => b.kind !== "meeting")) assert.ok(b.start >= "12:30", `block ${b.start} after now`);
  assert.ok(!p.plan.blocks.some((b: any) => b.taskId === focusId), "completed task not rescheduled");
  assert.equal(r.json.state.tasks.length, taskCount, "no duplicate tasks");
  const c = await api("POST", `/api/proposals/${p.id}/confirm`, {});
  assert.equal(c.status, 200);
  const plan = c.json.state.plan;
  assert.equal(plan.version, 2);
  assert.ok(plan.blocks.some((b: any) => b.taskId === focusId && b.end <= "12:30"), "completed focus block preserved");
  assert.ok(plan.blocks.some((b: any) => b.kind === "meeting" && b.start === "14:00"));
  assert.equal(c.json.state.planVersions.length, 2);
});

test("stale proposal: editing the plan after a proposal blocks confirming it", async () => {
  const s = await demoPlan();
  await api("POST", `/api/proposals/${s.proposal.id}/confirm`, {});
  process.env.NIKKI_FAKE_NOW = "2026-10-05T10:00:00Z";
  const r = await api("POST", "/api/replan", { clientRequestId: "replan-2-xxxxxxxx", remainingUntil: "17:00" });
  const proposal = r.json.state.proposal;
  const plan = r.json.state.plan;
  // user edits the confirmed plan meanwhile (removes the buffer)
  const { id, version, status, createdAt, proposalId, source, ...draft } = plan;
  draft.blocks = draft.blocks.filter((b: any) => b.kind !== "buffer");
  const e = await api("PUT", "/api/plan", { expectedVersion: version, plan: draft });
  assert.equal(e.status, 200);
  const c = await api("POST", `/api/proposals/${proposal.id}/confirm`, {});
  assert.equal(c.status, 409);
  assert.equal(c.json.code, "stale");
  // an edit based on an old version is also rejected
  const old = await api("PUT", "/api/plan", { expectedVersion: version, plan: draft });
  assert.equal(old.status, 409);
});

test("plan edits are validated: overlaps, meetings, window and budget", async () => {
  const s = await demoPlan();
  await api("POST", `/api/proposals/${s.proposal.id}/confirm`, {});
  const plan = (await api("GET", "/api/state")).json.state.plan;
  const { id, version, status, createdAt, proposalId, source, ...draft } = plan;
  const work = draft.blocks.find((b: any) => b.kind === "focus");
  const overlapMeeting = { ...draft, blocks: draft.blocks.map((b: any) => (b.id === work.id ? { ...b, start: "13:30", end: "14:30" } : b)) };
  const r1 = await api("PUT", "/api/plan", { expectedVersion: version, plan: overlapMeeting });
  assert.equal(r1.status, 422);
  assert.ok(r1.json.details.some((d: string) => /overlap/i.test(d)));
  const outside = { ...draft, blocks: [...draft.blocks, { start: "18:00", end: "19:00", kind: "task", taskId: work.taskId, title: "Late" }] };
  const r2 = await api("PUT", "/api/plan", { expectedVersion: version, plan: outside });
  assert.equal(r2.status, 422);
  assert.ok(r2.json.details.some((d: string) => /outside the available window/.test(d)));
  const overBudget = { ...draft, workBudgetMinutes: 60 };
  const r3 = await api("PUT", "/api/plan", { expectedVersion: version, plan: overBudget });
  assert.equal(r3.status, 422);
  assert.ok(r3.json.details.some((d: string) => /budget/.test(d)));
});

test("validator rejects moved meetings and unknown tasks", () => {
  const meetings = [{ id: "m1", date: "2026-10-05", title: "Meeting", start: "14:00", end: "16:00" }];
  const tasks = new Map([["t1", { id: "t1" } as any]]);
  const errs = validatePlanDraft(
    {
      date: "2026-10-05",
      mainOutcome: "x",
      focusTaskId: "t1",
      focusWhy: "",
      supporting: [{ taskId: "nope", why: "" }],
      deferred: [],
      reasons: [],
      assumptions: [],
      window: { start: "09:00", end: "17:00" },
      workBudgetMinutes: 120,
      blocks: [
        { id: "b1", start: "09:00", end: "10:00", kind: "focus", taskId: "t1", meetingId: null, title: "A" },
        { id: "b2", start: "15:00", end: "17:00", kind: "meeting", taskId: null, meetingId: "m1", title: "Meeting" },
        { id: "b3", start: "25:00", end: "26:00", kind: "task", taskId: "t1", meetingId: null, title: "Bad" },
      ],
    },
    { meetings, tasks },
  );
  assert.ok(errs.some((e) => /invalid time/.test(e)));
  const errs2 = validatePlanDraft(
    {
      date: "2026-10-05",
      mainOutcome: "x",
      focusTaskId: "t1",
      focusWhy: "",
      supporting: [{ taskId: "nope", why: "" }],
      deferred: [],
      reasons: [],
      assumptions: [],
      window: { start: "09:00", end: "17:00" },
      workBudgetMinutes: 120,
      blocks: [
        { id: "b1", start: "09:00", end: "10:00", kind: "focus", taskId: "t1", meetingId: null, title: "A" },
        { id: "b2", start: "15:00", end: "17:00", kind: "meeting", taskId: null, meetingId: "m1", title: "Meeting" },
      ],
    },
    { meetings, tasks },
  );
  assert.ok(errs2.some((e) => /may not move it/.test(e)));
  assert.ok(errs2.some((e) => /unknown task "nope"/.test(e)));
});

test("new day: offers to review unfinished work, then clears after review", async () => {
  const s = await demoPlan();
  await api("POST", `/api/proposals/${s.proposal.id}/confirm`, {});
  process.env.NIKKI_FAKE_NOW = "2026-10-06T07:30:00Z";
  const st = (await api("GET", "/api/state")).json.state;
  assert.equal(st.today, "2026-10-06");
  assert.equal(st.plan, null);
  assert.equal(st.newDay.lastPlanDate, "2026-10-05");
  assert.equal(st.newDay.unfinishedTaskIds.length, 3);
  const [a, b, c] = st.newDay.unfinishedTaskIds;
  const r = await api("POST", "/api/review", {
    decisions: [
      { taskId: a, action: "keep" },
      { taskId: b, action: "done" },
      { taskId: c, action: "park" },
    ],
  });
  assert.equal(r.json.state.newDay, null);
  assert.equal(r.json.state.tasks.find((t: any) => t.id === b).status, "done");
  assert.equal(r.json.state.tasks.find((t: any) => t.id === c).type, "idea");
});

test("timezone: 'today' follows the user's timezone", () => {
  const at = new Date("2026-10-05T23:30:00Z");
  assert.equal(localNow("Europe/London", at).date, "2026-10-06");
  assert.equal(localNow("America/Los_Angeles", at).date, "2026-10-05");
  assert.equal(localNow("Asia/Kolkata", at).time, "05:00");
});

test("duplicate submission with the same request id is processed once", async () => {
  const id = "dup-request-0001";
  const r1 = await send(EXAMPLE_DUMP, "demo", id);
  const r2 = await send(EXAMPLE_DUMP, "demo", id);
  assert.equal(r1.status, 200);
  assert.equal(r2.json.duplicate, true);
  const users = r2.json.state.messages.filter((m: any) => m.role === "user");
  assert.equal(users.length, 1);
});

test("personal workspace without API key returns a clear error and stores nothing", async () => {
  const r = await send("Plan my day", "personal");
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "no_api_key");
  const st = (await api("GET", "/api/state", undefined, "personal")).json.state;
  assert.equal(st.messages.length, 0);
  assert.equal(st.liveAvailable, false);
});

test("live: API failures surface as errors (no silent demo fallback) and the message is not kept", async () => {
  setProvider({
    name: "fake",
    model: "fake",
    generate: async () => {
      throw new ProviderError("Claude's rate limit was reached. Wait a minute and try again.", "rate_limit", 429);
    },
  });
  const r = await send("I need to write the report", "personal");
  assert.equal(r.status, 429);
  assert.equal(r.json.code, "rate_limit");
  const st = (await api("GET", "/api/state", undefined, "personal")).json.state;
  assert.equal(st.messages.length, 0);
  assert.equal(st.tasks.length, 0);
});

test("live: invalid JSON twice -> error; bad plan gets one repair attempt", async () => {
  let calls = 0;
  setProvider({ name: "fake", model: "fake", generate: async () => ({ text: (calls++, "not json"), model: "fake" }) });
  const r = await send("hello", "personal");
  assert.equal(r.status, 502);
  assert.equal(r.json.code, "invalid_output");
  assert.equal(calls, 2, "bounded retries");

  const base = {
    message: "Here's a plan.",
    questions: [],
    captured_items: [{ ref: "n1", kind: "action", title: "Write report", notes: null, estimate_minutes: 90, deadline: null, project: null, duplicate_of: null }],
    task_updates: [],
    meetings: [{ title: "Standup", start: "11:00", end: "11:30" }],
    context_updates: [{ field: "workStart", value: "09:00", reason: "You start at 9." }],
    availability: null,
  };
  const plan = (blocks: any[]) => ({
    main_outcome: "Report sent",
    focus: { task_ref: "n1", why: "Main outcome" },
    supporting: [],
    deferred: [],
    window: { start: "09:00", end: "13:00" },
    work_budget_minutes: 120,
    blocks,
    reasons: ["It matters most."],
    assumptions: [],
  });
  const bad = plan([
    { start: "10:30", end: "12:00", kind: "focus", task_ref: "n1", title: "Write report" }, // overlaps standup
    { start: "11:00", end: "11:30", kind: "meeting", task_ref: null, title: "Standup" },
  ]);
  const good = plan([
    { start: "09:00", end: "10:30", kind: "focus", task_ref: "n1", title: "Write report" },
    { start: "10:30", end: "10:45", kind: "buffer", task_ref: null, title: "Buffer" },
    { start: "11:00", end: "11:30", kind: "meeting", task_ref: null, title: "Standup" },
  ]);
  const seen: string[] = [];
  calls = 0;
  setProvider({
    name: "fake",
    model: "fake",
    generate: async (req) => {
      seen.push(req.messages.at(-1)!.content);
      return { text: JSON.stringify({ ...base, plan: calls++ === 0 ? bad : good }), model: "fake" };
    },
  });
  const r2 = await send("I need to write the report. Standup 11-11:30.", "personal");
  assert.equal(r2.status, 200);
  assert.equal(calls, 2);
  assert.match(seen[0], /<app_state>/);
  assert.match(seen[1], /overlaps the fixed meeting/);
  const st = r2.json.state;
  assert.equal(st.tasks.length, 1);
  assert.equal(st.meetings.length, 1);
  assert.equal(st.proposal.plan.focusTaskId, st.tasks[0].id);
  assert.equal(st.profile.workStart, "", "context suggestion not saved without confirmation");
  const sug = st.proposal.contextSuggestions[0];
  const saved = await api("POST", `/api/proposals/${st.proposal.id}/suggestions/${sug.id}`, { action: "save" }, "personal");
  assert.equal(saved.json.state.profile.workStart, "09:00");
});

test("live: concurrent submissions are rejected while one is in flight", async () => {
  let release: () => void = () => {};
  setProvider({
    name: "fake",
    model: "fake",
    generate: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            text: JSON.stringify({ message: "ok", questions: [], captured_items: [], task_updates: [], meetings: [], context_updates: [], availability: null, plan: null }),
            model: "fake",
          });
      }),
  });
  const p1 = send("first", "personal");
  await new Promise((r) => setTimeout(r, 50));
  const r2 = await send("second", "personal");
  assert.equal(r2.status, 409);
  release();
  assert.equal((await p1).status, 200);
});

test("export and delete personal data", async () => {
  await api("POST", "/api/tasks", { title: "Call accountant" }, "personal");
  const ex = await api("GET", "/api/export", undefined, "personal");
  assert.equal(ex.json.tasks.length, 1);
  assert.match(ex.json.note, /not used for model training/);
  const bad = await api("DELETE", "/api/data", {}, "personal");
  assert.equal(bad.status, 400);
  const del = await api("DELETE", "/api/data", { confirm: "DELETE" }, "personal");
  assert.equal(del.json.state.tasks.length, 0);
  // demo data is separate
  await send(EXAMPLE_DUMP);
  const demo = (await api("GET", "/api/state")).json.state;
  assert.ok(demo.tasks.length > 0);
  const personal = (await api("GET", "/api/state", undefined, "personal")).json.state;
  assert.equal(personal.tasks.length, 0);
});
