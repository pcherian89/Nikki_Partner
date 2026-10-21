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
  // The work budget follows from the blocks, so a figure that is too low never blocks an edit — it is raised to match.
  const lowBudget = { ...draft, workBudgetMinutes: 60 };
  const r3 = await api("PUT", "/api/plan", { expectedVersion: version, plan: lowBudget });
  assert.equal(r3.status, 200);
  assert.ok(r3.json.state.plan.workBudgetMinutes >= workMinutes(r3.json.state.plan));
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
      { taskId: a, action: "today" },
      { taskId: b, action: "done" },
      { taskId: c, action: "someday" },
    ],
  });
  assert.equal(r.json.state.newDay, null);
  const task = (id: string) => r.json.state.tasks.find((t: any) => t.id === id);
  assert.equal(task(a).plannedDate, "2026-10-06");
  assert.equal(task(a).rolloverCount, 1);
  assert.equal(task(b).status, "done");
  assert.equal(task(c).plannedDate, null);
  assert.equal(task(c).type, "action", "someday keeps it as an action, just unscheduled");
});

test("new day: also shows open tasks whose planned day passed, even when today is already planned", async () => {
  const t = (await api("POST", "/api/tasks", { title: "Send the tender docs", plannedDate: "2026-10-05" })).json.task;
  process.env.NIKKI_FAKE_NOW = "2026-10-07T07:30:00Z";
  const st = (await api("GET", "/api/state")).json.state;
  assert.deepEqual(st.newDay.unfinishedTaskIds, [t.id]);
  const r = await api("POST", "/api/review", { decisions: [{ taskId: t.id, action: "tomorrow" }] });
  const after = r.json.state.tasks.find((x: any) => x.id === t.id);
  assert.equal(after.plannedDate, "2026-10-08");
  assert.equal(after.rolloverCount, 1);
});

test("unfinished work: later today / another day / someday apply straight away and keep the plan consistent", async () => {
  const s = await demoPlan();
  await api("POST", `/api/proposals/${s.proposal.id}/confirm`, {});
  const plan = (await api("GET", "/api/state")).json.state.plan;
  const first = plan.blocks.find((b: any) => b.kind === "focus" || b.kind === "task");
  // Time passes beyond the first block without it being finished.
  const [h, m] = first.end.split(":").map(Number);
  process.env.NIKKI_FAKE_NOW = `2026-10-05T${String(h - 1).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
  // A full day has no room, and says so.
  const full = await api("POST", `/api/tasks/${first.taskId}/reschedule`, { to: "later_today" });
  assert.equal(full.status, 422);
  assert.match(full.json.error, /isn't 90 minutes free/);
  // Free up time by moving the other tasks to tomorrow, then it fits (split across the free gaps).
  const others = new Set(plan.blocks.filter((b: any) => b.taskId && b.taskId !== first.taskId).map((b: any) => b.taskId));
  for (const id of others) await api("POST", `/api/tasks/${id}/reschedule`, { to: "date", date: "2026-10-06" });
  const later = await api("POST", `/api/tasks/${first.taskId}/reschedule`, { to: "later_today" });
  assert.equal(later.status, 200, JSON.stringify(later.json));
  const moved = later.json.state.plan.blocks.filter((b: any) => b.taskId === first.taskId);
  assert.ok(moved.every((b: any) => b.start >= first.end), "the missed part moved to after now");
  const movedMinutes = moved.reduce((s: number, b: any) => s + (+b.end.slice(0, 2) * 60 + +b.end.slice(3)) - (+b.start.slice(0, 2) * 60 + +b.start.slice(3)), 0);
  assert.equal(movedMinutes, 90 + 30, "90 missed minutes re-placed, the 30 still to come kept");
  assert.match(later.json.message, /Moved/);

  const tom = await api("POST", `/api/tasks/${first.taskId}/reschedule`, { to: "date", date: "2026-10-06" });
  const st = tom.json.state;
  assert.ok(!st.plan.blocks.some((b: any) => b.taskId === first.taskId), "off today's plan");
  assert.ok(st.plan.deferred.some((d: any) => d.taskId === first.taskId));
  assert.notEqual(st.plan.focusTaskId, first.taskId);
  const t = st.tasks.find((x: any) => x.id === first.taskId);
  assert.equal(t.plannedDate, "2026-10-06");
  assert.equal(t.rolloverCount, 1);

  const past = await api("POST", `/api/tasks/${first.taskId}/reschedule`, { to: "date", date: "2026-10-01" });
  assert.equal(past.status, 400);
  const some = await api("POST", `/api/tasks/${first.taskId}/reschedule`, { to: "someday" });
  assert.equal(some.json.state.tasks.find((x: any) => x.id === first.taskId).plannedDate, null);
});

test("deleting or re-dating a task takes it off today's plan", async () => {
  const s = await demoPlan();
  await api("POST", `/api/proposals/${s.proposal.id}/confirm`, {});
  const plan = (await api("GET", "/api/state")).json.state.plan;
  const [x, y] = [plan.focusTaskId, plan.supporting[0].taskId];
  const d = await api("DELETE", `/api/tasks/${x}`);
  assert.ok(!d.json.state.plan.blocks.some((b: any) => b.taskId === x));
  assert.equal(d.json.state.plan.focusTaskId, null);
  const p = await api("PATCH", `/api/tasks/${y}`, { plannedDate: "2026-10-08" });
  assert.ok(!p.json.state.plan.blocks.some((b: any) => b.taskId === y));
  // The remaining plan still passes its own checks (edits keep working).
  const again = await api("PUT", "/api/plan", { expectedVersion: p.json.state.plan.version, plan: p.json.state.plan });
  assert.equal(again.status, 200, JSON.stringify(again.json));
});

test("live: 'take X off today' is a confirmable change that really removes it once confirmed", async () => {
  const empty = { questions: [], quick_replies: [], captured_items: [], task_updates: [], meetings: [], context_updates: [], plan: null };
  let turn = 0;
  let ids: string[] = [];
  setProvider({
    name: "fake",
    model: "fake",
    generate: async () => {
      turn++;
      if (turn === 1) {
        return {
          model: "fake",
          text: JSON.stringify({
            ...empty,
            message: "Here's a plan.",
            captured_items: [
              { ref: "n1", kind: "action", title: "Write report", notes: "", estimate_minutes: 60, deadline: "", planned_date: "", project: "", duplicate_of: "" },
              { ref: "n2", kind: "action", title: "Tenders", notes: "", estimate_minutes: 60, deadline: "", planned_date: "", project: "", duplicate_of: "" },
            ],
            plan: {
              date: "2026-10-05",
              main_outcome: "Report done",
              focus: { task_ref: "n1", why: "" },
              supporting: [{ task_ref: "n2", why: "" }],
              deferred: [],
              window: { start: "10:00", end: "13:00" },
              work_budget_minutes: 120,
              blocks: [
                { start: "10:00", end: "11:00", kind: "focus", task_ref: "n1", title: "Write report" },
                { start: "11:00", end: "12:00", kind: "task", task_ref: "n2", title: "Tenders" },
              ],
              reasons: [],
              assumptions: [],
            },
          }),
        };
      }
      return {
        model: "fake",
        text: JSON.stringify({
          ...empty,
          message: "I've set up taking the tenders off today — tap Confirm to apply it.",
          task_updates: [{ task_id: ids[1], change: "unschedule", title: "", estimate_minutes: 0, deadline: "", planned_date: "", notes: "", reason: "You asked." }],
        }),
      };
    },
  });
  const r1 = await send("Report and tenders today", "personal");
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  await api("POST", `/api/proposals/${r1.json.state.proposal.id}/confirm`, {}, "personal");
  ids = r1.json.state.proposal.plan.blocks.filter((b: any) => b.taskId).map((b: any) => b.taskId);
  const r2 = await send("Remove the tenders from today", "personal");
  const st = r2.json.state;
  assert.ok(st.plan.blocks.some((b: any) => b.taskId === ids[1]), "nothing changes before confirming");
  assert.equal(st.proposal.taskChanges[0].change, "unschedule");
  const c = await api("POST", `/api/proposals/${st.proposal.id}/confirm`, {}, "personal");
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.ok(!c.json.state.plan.blocks.some((b: any) => b.taskId === ids[1]), "gone after confirming");
  assert.equal(c.json.state.plan.supporting.length, 0);
  assert.equal(c.json.state.plan.workBudgetMinutes, 60);
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

// ---------- new: day rhythm, task helpers, learning ----------

test("evening wrap-up applies decisions, saves a journal entry and drives the next morning", async () => {
  const s = await demoPlan();
  await api("POST", `/api/proposals/${s.proposal.id}/confirm`, {});
  const plan = s.proposal.plan;
  const focusId = plan.focusTaskId;
  const [sup1, sup2] = plan.supporting.map((x: any) => x.taskId);
  await api("PATCH", `/api/tasks/${focusId}`, { status: "done" });
  process.env.NIKKI_FAKE_NOW = "2026-10-05T17:00:00Z";
  const w = await api("POST", "/api/wrapup", {
    decisions: [
      { taskId: sup1, action: "tomorrow" },
      { taskId: sup2, action: "someday" },
    ],
    note: "Proposal felt good. Tired.",
  });
  assert.equal(w.status, 200);
  const st = w.json.state;
  assert.deepEqual(st.wrapUpToday.doneTaskIds, [focusId]);
  assert.deepEqual(st.wrapUpToday.tomorrowTaskIds, [sup1]);
  assert.equal(st.tasks.find((t: any) => t.id === sup2).plannedDate, null);
  assert.equal(st.tasks.find((t: any) => t.id === sup1).plannedDate, "2026-10-06", "tomorrow really moves it");
  assert.ok(st.messages.at(-1).meta.system, "wrap-up note in chat");
  // Optional reflection (demo: scripted, never a plan)
  const r = await api("POST", "/api/messages", { text: "Evening wrap-up.\nDone today: Finish a proposal\nMoving to tomorrow: Review beta feedback", clientRequestId: "wrap-reflect-1", kind: "wrapup" });
  assert.equal(r.status, 200);
  assert.match(r.json.state.messages.at(-1).text, /finished Finish a proposal/);
  assert.equal(r.json.state.proposal, null);
  // Next morning: no "unfinished" review (already decided), check-in data available
  process.env.NIKKI_FAKE_NOW = "2026-10-06T07:30:00Z";
  const next = (await api("GET", "/api/state")).json.state;
  assert.equal(next.newDay, null);
  assert.equal(next.lastWrapUp.date, "2026-10-05");
  assert.deepEqual(next.lastWrapUp.tomorrowTaskIds, [sup1]);
  assert.equal(next.wrapUpToday, null);
});

test("break it down (demo): template steps, save, tick", async () => {
  const t = (await api("POST", "/api/tasks", { title: "Finish the website and publish it live", estimateMinutes: 120 })).json.task;
  const b = await api("POST", `/api/tasks/${t.id}/breakdown`, {});
  assert.equal(b.status, 200);
  assert.equal(b.json.demo, true);
  assert.ok(b.json.steps.length >= 3);
  const saved = await api("PUT", `/api/tasks/${t.id}/steps`, { steps: b.json.steps });
  const steps = saved.json.state.tasks.find((x: any) => x.id === t.id).steps;
  assert.equal(steps.length, b.json.steps.length);
  const tick = await api("PATCH", `/api/steps/${steps[0].id}`, { done: true });
  assert.equal(tick.json.state.tasks.find((x: any) => x.id === t.id).steps[0].done, true);
  // re-saving keeps done state for kept steps
  const again = await api("PUT", `/api/tasks/${t.id}/steps`, { steps: steps.map((x: any) => ({ id: x.id, title: x.title, minutes: x.minutes })) });
  assert.equal(again.json.state.tasks.find((x: any) => x.id === t.id).steps[0].done, true);
});

test("help me start (demo) saves a labelled template draft; delete works", async () => {
  const t = (await api("POST", "/api/tasks", { title: "Follow up with the client" })).json.task;
  const a = await api("POST", `/api/tasks/${t.id}/assist`, { ask: "email" });
  assert.equal(a.status, 200);
  assert.equal(a.json.draft.demo, true);
  assert.equal(a.json.draft.format, "email");
  assert.match(a.json.draft.content, /\[name\]/);
  assert.equal(a.json.state.drafts.length, 1);
  const d = await api("DELETE", `/api/drafts/${a.json.draft.id}`);
  assert.equal(d.json.state.drafts.length, 0);
});

test("live helpers: breakdown and draft go through the provider and are validated", async () => {
  let calls = 0;
  setProvider({
    name: "fake",
    model: "fake",
    generate: async (req) => {
      calls++;
      if (req.system.includes("Break ONE task")) {
        return calls === 1
          ? { text: "oops", model: "fake" }
          : { text: JSON.stringify({ steps: [{ title: "Outline the pages", minutes: 15 }, { title: "Write the copy", minutes: 45 }], note: "" }), model: "fake" };
      }
      return { text: JSON.stringify({ format: "email", title: "Ask for feedback", content: "Hi [name], ...", next_step: "Send it." }), model: "fake" };
    },
  });
  const t = (await api("POST", "/api/tasks", { title: "Website copy" }, "personal")).json.task;
  const b = await api("POST", `/api/tasks/${t.id}/breakdown`, {}, "personal");
  assert.equal(b.status, 200);
  assert.equal(b.json.demo, false);
  assert.equal(b.json.steps.length, 2);
  assert.equal(calls, 2, "one repair after invalid JSON");
  const a = await api("POST", `/api/tasks/${t.id}/assist`, { ask: "" }, "personal");
  assert.equal(a.json.draft.title, "Ask for feedback");
  assert.equal(a.json.draft.demo, false);
});

test("learning: real durations produce an estimate factor that the planner uses", async () => {
  for (const [est, actual] of [
    [60, 90],
    [30, 45],
    [120, 180],
  ]) {
    const t = (await api("POST", "/api/tasks", { title: `Past task ${est}`, estimateMinutes: est })).json.task;
    await api("PATCH", `/api/tasks/${t.id}`, { status: "done" });
    await api("PATCH", `/api/tasks/${t.id}`, { actualMinutes: actual });
  }
  const st = (await api("GET", "/api/state")).json.state;
  assert.equal(st.learning.samples, 3);
  assert.equal(st.learning.factor, 1.5);
  // Demo planning now schedules the 120-min proposal as 180 min of work.
  const s = await demoPlan();
  const focus = s.proposal.plan.focusTaskId;
  const focusMinutes = s.proposal.plan.blocks
    .filter((b: any) => b.taskId === focus)
    .reduce((a: number, b: any) => a + (Number(b.end.slice(0, 2)) * 60 + Number(b.end.slice(3)) - Number(b.start.slice(0, 2)) * 60 - Number(b.start.slice(3))), 0);
  assert.equal(focusMinutes, 180);
});

test("focus timer: one at a time; finishing records time", async () => {
  const a = (await api("POST", "/api/tasks", { title: "Task A", estimateMinutes: 30 })).json.task;
  const b = (await api("POST", "/api/tasks", { title: "Task B" })).json.task;
  await api("POST", `/api/tasks/${a.id}/timer`, { action: "start" });
  const refused = await api("POST", `/api/tasks/${b.id}/timer`, { action: "start" });
  assert.equal(refused.status, 409, "a silent overlap is refused");
  assert.equal(refused.json.code, "timer_running");
  const s2 = (await api("POST", `/api/tasks/${b.id}/timer`, { action: "start", switch: "pause" })).json.state;
  assert.equal(s2.tasks.find((t: any) => t.id === a.id).timerStartedAt, null, "switching pauses A");
  assert.ok(s2.tasks.find((t: any) => t.id === b.id).timerStartedAt);
  // simulate 40 minutes of focus on B
  getDb("demo").prepare("UPDATE tasks SET timer_started_at = ? WHERE id = ?").run(new Date(new Date(process.env.NIKKI_FAKE_NOW!).getTime() - 40 * 60000).toISOString(), b.id);
  const done = (await api("PATCH", `/api/tasks/${b.id}`, { status: "done" })).json.task;
  assert.equal(done.timerStartedAt, null);
  assert.equal(done.spentMinutes, 40);
  assert.equal(done.actualMinutes, 40);
});

// ---------- v3: context memory, dated commitments, tomorrow's plan, quick replies ----------

function liveReply(over: Record<string, unknown>) {
  return JSON.stringify({
    message: "ok",
    questions: [],
    quick_replies: [],
    captured_items: [],
    task_updates: [],
    meetings: [],
    context_updates: [],
    actions: [],
    plan: null,
    ...over,
  });
}

test("context suggestions: list fields only add lines, never duplicate, and decided ones don't come back", async () => {
  await api("PUT", "/api/profile", { preferences: "Deep work in the morning" }, "personal");
  let next = liveReply({ context_updates: [{ field: "preferences", value: "SRTSU work takes priority", reason: "You said so." }] });
  setProvider({ name: "fake", model: "fake", generate: async () => ({ text: next, model: "fake" }) });
  const r1 = await send("SRTSU work always comes first", "personal");
  const p1 = r1.json.state.proposal;
  assert.equal(p1.contextSuggestions.length, 1);
  const saved = await api("POST", `/api/proposals/${p1.id}/suggestions/${p1.contextSuggestions[0].id}`, { action: "save" }, "personal");
  assert.equal(saved.json.state.profile.preferences, "Deep work in the morning\nSRTSU work takes priority");
  // The model suggests the same thing again (and a rewrite that adds nothing) -> both filtered out
  next = liveReply({
    context_updates: [{ field: "preferences", value: "SRTSU work takes priority. Deep work in the morning.", reason: "Cleanup" }],
  });
  const r2 = await send("ok", "personal");
  assert.equal(r2.json.state.proposal, null, "no repeat suggestion");
  // A dismissed suggestion is not shown again
  next = liveReply({ context_updates: [{ field: "goals", value: "Launch the website", reason: "New goal" }] });
  const r3 = await send("my goal is launching the website", "personal");
  const p3 = r3.json.state.proposal;
  await api("POST", `/api/proposals/${p3.id}/suggestions/${p3.contextSuggestions[0].id}`, { action: "dismiss" }, "personal");
  const r4 = await send("again", "personal");
  assert.equal(r4.json.state.proposal, null);
  // Saving the profile removes duplicate lines
  const d = await api("PUT", "/api/profile", { preferences: "A\nB\na\nB." }, "personal");
  assert.equal(d.json.state.profile.preferences, "A\nB");
});

test("commitments on any date are saved and appear in 'upcoming'; past dates are refused", async () => {
  setProvider({
    name: "fake",
    model: "fake",
    generate: async () => ({
      text: liveReply({
        meetings: [
          { date: "2026-10-12", title: "Client review", start: "15:00", end: "16:00" },
          { date: "2026-10-01", title: "Old thing", start: "10:00", end: "11:00" },
          { date: "", title: "Standup", start: "11:00", end: "11:15" },
        ],
      }),
      model: "fake",
    }),
  });
  const r = await send("Client review next Monday 3pm, standup at 11 today", "personal");
  const st = r.json.state;
  assert.deepEqual(st.upcoming.map((m: any) => [m.date, m.title]), [["2026-10-12", "Client review"]]);
  assert.deepEqual(st.meetings.map((m: any) => m.title), ["Standup"]);
  assert.ok(st.messages.at(-1).meta.notes.some((n: string) => /Old thing/.test(n)));
  // Manual add with a date
  const m = await api("POST", "/api/meetings", { title: "Dentist", date: "2026-10-06", start: "09:00", end: "09:30" }, "personal");
  assert.equal(m.json.state.tomorrow.meetings[0].title, "Dentist");
  const past = await api("POST", "/api/meetings", { title: "Late", date: "2026-10-04", start: "09:00", end: "09:30" }, "personal");
  assert.equal(past.status, 400);
});

test("plans for tomorrow are proposed, confirmed and kept separate from today", async () => {
  await api("POST", "/api/meetings", { title: "Dentist", date: "2026-10-06", start: "09:00", end: "09:30" }, "personal");
  const t = (await api("POST", "/api/tasks", { title: "Write newsletter", estimateMinutes: 60 }, "personal")).json.task;
  setProvider({
    name: "fake",
    model: "fake",
    generate: async () => ({
      text: liveReply({
        quick_replies: ["Looks good", "Make it lighter"],
        plan: {
          date: "2026-10-06",
          main_outcome: "Newsletter out",
          focus: { task_ref: t.id, why: "Main thing" },
          supporting: [],
          deferred: [],
          window: { start: "09:00", end: "13:00" },
          work_budget_minutes: 120,
          blocks: [
            { start: "09:00", end: "09:30", kind: "meeting", task_ref: "", title: "Dentist" },
            { start: "10:00", end: "11:00", kind: "focus", task_ref: t.id, title: "Write newsletter" },
          ],
          reasons: [],
          assumptions: [],
        },
      }),
      model: "fake",
    }),
  });
  const r = await send("Let's plan tomorrow", "personal");
  const st = r.json.state;
  assert.equal(st.proposal.date, "2026-10-06");
  assert.deepEqual(st.messages.at(-1).meta.quickReplies, ["Looks good", "Make it lighter"]);
  const c = await api("POST", `/api/proposals/${st.proposal.id}/confirm`, {}, "personal");
  assert.equal(c.status, 200);
  assert.equal(c.json.state.plan, null, "today untouched");
  assert.equal(c.json.state.tomorrow.plan.mainOutcome, "Newsletter out");
  // Next day it becomes today's plan
  process.env.NIKKI_FAKE_NOW = "2026-10-06T07:00:00Z";
  const next = (await api("GET", "/api/state", undefined, "personal")).json.state;
  assert.equal(next.plan.mainOutcome, "Newsletter out");
});

test("demo: 'plan tomorrow' proposes a plan dated tomorrow", async () => {
  await api("POST", "/api/tasks", { title: "Call the bank", estimateMinutes: 30 });
  const r = await send("Can you plan tomorrow for me?");
  assert.equal(r.json.state.proposal.date, "2026-10-06");
  assert.ok(r.json.state.proposal.plan.blocks.length > 0);
});

// ---------- v4: removable context, week planning ----------

test("Nikki can suggest removing a context item; it's only removed when confirmed", async () => {
  await api("PUT", "/api/profile", { projects: "Website launch\nSRTSU coaching" }, "personal");
  const reply = (over: Record<string, unknown>) => ({ text: liveReply(over), model: "fake" });
  let next = reply({ context_updates: [{ action: "remove", field: "projects", value: "website launch", reason: "You stopped." }] });
  setProvider({ name: "fake", model: "fake", generate: async () => next });
  const r = await send("I'm not working on the website any more", "personal");
  const p = r.json.state.proposal;
  assert.equal(p.contextSuggestions[0].action, "remove");
  assert.equal(p.contextSuggestions[0].value, "Website launch", "points at the exact saved line");
  assert.equal(r.json.state.profile.projects, "Website launch\nSRTSU coaching", "nothing removed yet");
  const done = await api("POST", `/api/proposals/${p.id}/suggestions/${p.contextSuggestions[0].id}`, { action: "save" }, "personal");
  assert.equal(done.json.state.profile.projects, "SRTSU coaching");
  // Removing something that isn't saved is ignored
  next = reply({ context_updates: [{ action: "remove", field: "goals", value: "Run a marathon", reason: "x" }] });
  const r2 = await send("no more marathon", "personal");
  assert.equal(r2.json.state.proposal, null);
});

test("week planning: tasks get a day via confirmed task changes or directly", async () => {
  const a = (await api("POST", "/api/tasks", { title: "Invoices", estimateMinutes: 30 }, "personal")).json.task;
  const b = (await api("POST", "/api/tasks", { title: "Pitch deck", estimateMinutes: 120 }, "personal")).json.task;
  setProvider({
    name: "fake",
    model: "fake",
    generate: async () => ({
      text: liveReply({
        task_updates: [
          { task_id: a.id, change: "update", title: "", estimate_minutes: 0, deadline: "", planned_date: "2026-10-08", notes: "", reason: "Light day" },
          { task_id: b.id, change: "update", title: "", estimate_minutes: 0, deadline: "", planned_date: "2026-10-01", notes: "", reason: "past date" },
        ],
      }),
      model: "fake",
    }),
  });
  const r = await send("Spread my tasks over the week", "personal");
  const p = r.json.state.proposal;
  assert.equal(p.taskChanges[0].plannedDate, "2026-10-08");
  assert.equal(p.taskChanges[1].plannedDate, null, "past days are not allowed");
  const c = await api("POST", `/api/proposals/${p.id}/confirm`, { acceptedTaskChangeIds: [p.taskChanges[0].id] }, "personal");
  assert.equal(c.json.state.tasks.find((t: any) => t.id === a.id).plannedDate, "2026-10-08");
  const d = await api("PATCH", `/api/tasks/${b.id}`, { plannedDate: "2026-10-07" }, "personal");
  assert.equal(d.json.task.plannedDate, "2026-10-07");
  const u = await api("PATCH", `/api/tasks/${b.id}`, { plannedDate: null }, "personal");
  assert.equal(u.json.task.plannedDate, null);
});

test("export -> import round-trip restores a workspace", async () => {
  await api("PUT", "/api/profile", { name: "Pothen", projects: "Revivo IQ" }, "personal");
  const t = (await api("POST", "/api/tasks", { title: "Ship it", estimateMinutes: 45 }, "personal")).json.task;
  await api("PUT", `/api/tasks/${t.id}/steps`, { steps: [{ title: "Step one", minutes: 10 }] }, "personal");
  await api("POST", "/api/meetings", { title: "Review", date: "2026-10-09", start: "10:00", end: "11:00" }, "personal");
  const exported = (await api("GET", "/api/export", undefined, "personal")).json;
  await api("DELETE", "/api/data", { confirm: "DELETE" }, "personal");
  const bad = await api("POST", "/api/import", { confirm: "REPLACE", data: { hello: 1 } }, "personal");
  assert.equal(bad.status, 400);
  const r = await api("POST", "/api/import", { confirm: "REPLACE", data: exported }, "personal");
  assert.equal(r.status, 200);
  const st = r.json.state;
  assert.equal(st.profile.name, "Pothen");
  assert.equal(st.tasks[0].title, "Ship it");
  assert.equal(st.tasks[0].steps[0].title, "Step one");
  assert.equal(st.upcoming[0].title, "Review");
});

// ---------- v5: linked calendars (read-only .ics) ----------

const SAMPLE_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Test//EN",
  "BEGIN:VEVENT",
  "UID:daily-standup@test",
  "SUMMARY:Team sync",
  "DTSTART;TZID=Europe/London:20261005T143000",
  "DTEND;TZID=Europe/London:20261005T153000",
  "RRULE:FREQ=DAILY;COUNT=3",
  "EXDATE;TZID=Europe/London:20261006T143000",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:holiday@test",
  "SUMMARY:Holiday",
  "DTSTART;VALUE=DATE:20261008",
  "DTEND;VALUE=DATE:20261009",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:utc@test",
  "SUMMARY:Investor call",
  "DTSTART:20261009T090000Z",
  "DTEND:20261009T093000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:cancelled@test",
  "SUMMARY:Cancelled thing",
  "STATUS:CANCELLED",
  "DTSTART:20261005T100000Z",
  "DTEND:20261005T110000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:overlap@test",
  "SUMMARY:Overlapping call",
  "DTSTART;TZID=Europe/London:20261005T150000",
  "DTEND;TZID=Europe/London:20261005T160000",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("linked calendar: events sync read-only, repeating events expand, all-day/cancelled are skipped", async () => {
  const http = await import("node:http");
  let ics = SAMPLE_ICS;
  const cal = http.createServer((req, res) => {
    if (req.url === "/cal.ics") {
      res.writeHead(200, { "content-type": "text/calendar" });
      res.end(ics);
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise<void>((r) => cal.listen(0, r));
  const url = `http://localhost:${(cal.address() as AddressInfo).port}/cal.ics`;
  try {
    const bad = await api("POST", "/api/calendars", { name: "Bad", url: url.replace("cal.ics", "missing.ics") }, "personal");
    assert.equal(bad.status, 422);
    const r = await api("POST", "/api/calendars", { name: "Google", url: url.replace("http://", "webcal://").replace("webcal://", "http://") }, "personal");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const st = r.json.state;
    assert.equal(st.calendars.length, 1);
    assert.ok(!JSON.stringify(st.calendars).includes("/cal.ics"), "private link isn't sent to the browser");
    assert.deepEqual(
      st.meetings.map((m: any) => [m.title, m.start, m.end, m.source]),
      [
        ["Team sync", "14:30", "15:30", "calendar"],
        ["Overlapping call", "15:00", "16:00", "calendar"],
      ],
    );
    assert.equal(st.tomorrow.meetings.length, 0, "EXDATE removed the 6th");
    const up = st.upcoming.map((m: any) => [m.date, m.title, m.start]);
    assert.deepEqual(up, [
      ["2026-10-07", "Team sync", "14:30"],
      ["2026-10-09", "Investor call", "10:00"],
    ]);
    // Read-only
    const id = st.meetings[0].id;
    assert.equal((await api("DELETE", `/api/meetings/${id}`, undefined, "personal")).status, 400);
    assert.equal((await api("PATCH", `/api/meetings/${id}`, { title: "x", start: "09:00", end: "10:00" }, "personal")).status, 400);
    // Re-sync picks up changes and keeps ids stable
    ics = ics.replace("SUMMARY:Investor call", "SUMMARY:Investor call (moved)").replace("20261009T090000Z", "20261009T100000Z").replace("20261009T093000Z", "20261009T103000Z");
    const s2 = await api("POST", `/api/calendars/${st.calendars[0].id}/sync`, {}, "personal");
    assert.ok(s2.json.state.upcoming.some((m: any) => m.title === "Investor call (moved)" && m.start === "11:00"));
    assert.equal(s2.json.state.meetings[0].id, id);
    // Remove the calendar -> its events disappear
    const rm = await api("DELETE", `/api/calendars/${st.calendars[0].id}`, undefined, "personal");
    assert.equal(rm.json.state.meetings.length, 0);
    assert.equal(rm.json.state.calendars.length, 0);
  } finally {
    cal.close();
  }
});

test("plans can be confirmed around overlapping calendar events", async () => {
  const http = await import("node:http");
  const cal = http.createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/calendar" });
    res.end(SAMPLE_ICS);
  });
  await new Promise<void>((r) => cal.listen(0, r));
  try {
    await api("POST", "/api/calendars", { name: "Apple", url: `http://localhost:${(cal.address() as AddressInfo).port}/x.ics` });
    const s = await demoPlan();
    assert.ok(s.proposal?.plan, "demo proposal made");
    const c = await api("POST", `/api/proposals/${s.proposal.id}/confirm`, {});
    assert.equal(c.status, 200, JSON.stringify(c.json));
    const meetings = c.json.state.plan.blocks.filter((b: any) => b.kind === "meeting").map((b: any) => b.title);
    assert.ok(meetings.includes("Team sync") && meetings.includes("Overlapping call"));
  } finally {
    cal.close();
  }
});

// ---------- v6: "Nikki in your calendar" subscription feed ----------

test("Nikki calendar feed: private link serves confirmed plans as valid iCalendar", async () => {
  const { default: IcalExpander } = await import("ical-expander");
  const { localToUtc } = await import("../time.js");
  // DST-aware local -> UTC
  assert.equal(localToUtc("2026-10-05", "10:00", "Europe/London").toISOString(), "2026-10-05T09:00:00.000Z");
  assert.equal(localToUtc("2026-12-05", "10:00", "Europe/London").toISOString(), "2026-12-05T10:00:00.000Z");
  assert.equal(localToUtc("2026-10-05", "10:00", "Asia/Kolkata").toISOString(), "2026-10-05T04:30:00.000Z");

  const s = await demoPlan();
  await api("POST", `/api/proposals/${s.proposal.id}/confirm`, {});
  const t = (await api("POST", "/api/tasks", { title: "Invoices, receipts; taxes", plannedDate: "2026-10-08" })).json.task;
  const created = await api("POST", "/api/calendar-feed", { action: "create" });
  const token = created.json.state.nikkiFeedToken;
  assert.match(token, /^[0-9a-f]{48}$/);

  const res = await fetch(`${base}/cal/${token}.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/calendar/);
  const ics = await res.text();
  assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "lines folded");
  assert.match(ics, /X-WR-CALNAME:Nikki/);
  const parsed = new IcalExpander({ ics }).all();
  const titles = parsed.events.map((e: any) => e.summary);
  assert.ok(titles.includes("Focus: Finish a proposal"));
  const focus = parsed.events.find((e: any) => e.summary === "Focus: Finish a proposal")!;
  assert.equal(focus.startDate.toJSDate().toISOString(), "2026-10-05T09:00:00.000Z", "10:00 London = 09:00Z");
  assert.ok(titles.includes("Meeting"), "meeting added in Nikki is included");
  assert.ok(titles.includes("Nikki: Invoices, receipts; taxes"), "planned-day task as all-day event with escaping");
  assert.ok(parsed.events.find((e: any) => e.summary.startsWith("Nikki: Invoices")).startDate.isDate);
  void t;

  assert.equal((await fetch(`${base}/cal/${"0".repeat(48)}.ics`)).status, 404);
  const reset = await api("POST", "/api/calendar-feed", { action: "reset" });
  assert.notEqual(reset.json.state.nikkiFeedToken, token);
  assert.equal((await fetch(`${base}/cal/${token}.ics`)).status, 404, "old link stops working");
  await api("POST", "/api/calendar-feed", { action: "disable" });
  assert.equal((await fetch(`${base}/cal/${reset.json.state.nikkiFeedToken}.ics`)).status, 404);
});

test("wrap-up and morning review can send unfinished work to a picked day", async () => {
  const a = (await api("POST", "/api/tasks", { title: "Tender pack", plannedDate: "2026-10-05" })).json.task;
  const b = (await api("POST", "/api/tasks", { title: "Sports night poster", plannedDate: "2026-10-05" })).json.task;
  const w = await api("POST", "/api/wrapup", { decisions: [{ taskId: a.id, action: "date", date: "2026-10-09" }], note: "" });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  assert.equal(w.json.state.tasks.find((t: any) => t.id === a.id).plannedDate, "2026-10-09");
  process.env.NIKKI_FAKE_NOW = "2026-10-06T07:30:00Z";
  const st = (await api("GET", "/api/state")).json.state;
  assert.deepEqual(st.newDay.unfinishedTaskIds, [b.id]);
  const r = await api("POST", "/api/review", { decisions: [{ taskId: b.id, action: "date", date: "2026-10-12" }] });
  assert.equal(r.json.state.tasks.find((t: any) => t.id === b.id).plannedDate, "2026-10-12");
});

test("day bar: meetings + work + breaks + buffer + unscheduled always add up to the working window", async () => {
  const { capacity } = await import("../../src/util.js");
  const b = (start: string, end: string, kind: string) => ({ id: start, start, end, kind, taskId: null, meetingId: null, title: "" }) as any;
  // The owner's case: 9–5, 6h 5m of work, 1h 15m of breaks, no meetings.
  const c1 = capacity({
    window: { start: "09:00", end: "17:00" },
    workBudgetMinutes: 365,
    blocks: [b("09:00", "11:00", "focus"), b("11:00", "11:30", "break"), b("11:30", "13:30", "task"), b("13:30", "14:15", "break"), b("14:15", "16:20", "task")],
  });
  assert.equal(c1.window, 480);
  assert.equal(c1.work, 365);
  assert.equal(c1.breaks, 75);
  assert.equal(c1.meetings + c1.work + c1.breaks + c1.buffer + c1.open, c1.window);
  // Overlapping meetings are counted once; meetings outside the window don't count.
  const c2 = capacity({
    window: { start: "09:00", end: "17:00" },
    workBudgetMinutes: 0,
    blocks: [b("10:00", "11:00", "meeting"), b("10:30", "11:30", "meeting"), b("16:30", "18:00", "meeting")],
  });
  assert.equal(c2.meetings, 90 + 30);
  assert.equal(c2.meetings + c2.open, 480);
});
