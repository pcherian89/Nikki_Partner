import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-proj-"));
process.env.DATABASE_PATH = path.join(tmp, "nikki.db");
process.env.ANTHROPIC_API_KEY = "";
process.env.NIKKI_FAKE_NOW = "2026-10-21T08:00:00Z";

const { app } = await import("../index.js");
const { setProvider } = await import("../provider/index.js");
const { getDb, wipe, closeAll } = await import("../db.js");

const TZ = "Europe/London";
let server: Server;
let base = "";
let rid = 0;
const at = (iso: string) => (process.env.NIKKI_FAKE_NOW = iso);
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
  at("2026-10-21T08:00:00Z");
});

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json", "x-workspace": "personal", "x-timezone": TZ, "x-client-id": "dev-a" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
const state = async () => (await api("GET", "/api/state")).json.state;
const blank = { questions: [], quick_replies: [], captured_items: [], task_updates: [], actions: [], meetings: [], context_updates: [], project_plan: null, plan: null };
const fakeReply = (over: Record<string, unknown>) => setProvider({ name: "fake", model: "fake", generate: async () => ({ model: "fake", text: JSON.stringify({ ...blank, message: "ok", ...over }) }) });
const chat = (text: string) => api("POST", "/api/messages", { text, kind: "chat", clientRequestId: `req-${++rid}-xxxxxxxx` });
const act = (type: string, over: Record<string, unknown> = {}) => ({ type, task_id: "", minutes: 0, from: "", to: "", date: "", time: "", priority: "", flag: false, ...over });

const launch = (over: Record<string, unknown> = {}) => ({
  project_id: "",
  title: "Launch the AI app",
  goal: "Build and launch an AI application in three months.",
  target_date: "2027-01-21",
  assumptions: ["About 10 hours a week", "Solo build"],
  dependencies: ["Pick the first use case before building"],
  milestones: [
    { id: "", ref: "m1", title: "Validate the idea", target_date: "2026-11-04", remove: false },
    { id: "", ref: "m2", title: "Build the prototype", target_date: "2026-12-09", remove: false },
    { id: "", ref: "m3", title: "Launch", target_date: "2027-01-21", remove: false },
  ],
  tasks: [
    { ref: "t1", title: "Interview five potential users", milestone_ref: "m1", priority: "high", estimate_minutes: 0 },
    { ref: "t2", title: "Write the one-page spec", milestone_ref: "m1", priority: "normal", estimate_minutes: 0 },
    { ref: "t3", title: "Set up the repository", milestone_ref: "m2", priority: "normal", estimate_minutes: 90 },
  ],
  reason: "Three months with milestones about a month apart.",
  ...over,
});

async function createLaunch() {
  fakeReply({ project_plan: launch() });
  const r = await chat("I want to build and launch an AI application over the next three months. Help me create a realistic plan.");
  const c = await api("POST", `/api/proposals/${r.json.state.proposal.id}/confirm`, {});
  assert.equal(c.status, 200);
  return (await state()).projects[0];
}

test("a three-month goal is proposed, not saved, until the user confirms; nothing lands on Today", async () => {
  fakeReply({ questions: ["How many hours a week can you give it?"], message: "One question first." });
  const q = await chat("I want to build and launch an AI application over the next three months.");
  assert.equal(q.json.state.projects.length, 0);
  assert.equal(q.json.state.proposal, null, "a clarifying question proposes nothing");
  fakeReply({ project_plan: launch() });
  const r = await chat("About ten hours a week");
  const s = r.json.state;
  assert.equal(s.projects.length, 0, "proposed only");
  assert.equal(s.tasks.length, 0);
  assert.equal(s.proposal.projectPlan.milestones.length, 3);
  const c = await api("POST", `/api/proposals/${s.proposal.id}/confirm`, {});
  assert.equal(c.status, 200);
  const after = (await state());
  const p = after.projects[0];
  assert.equal(p.title, "Launch the AI app");
  assert.equal(p.status, "active");
  assert.equal(p.milestones.length, 3);
  assert.deepEqual(p.assumptions, ["About 10 hours a week", "Solo build"]);
  assert.equal(after.tasks.length, 3);
  assert.ok(after.tasks.every((t: any) => t.projectId === p.id && t.plannedDate === null), "tasks are linked and unassigned");
  assert.equal(after.days[0].openIds.length, 0, "the project did not flood Today");
  const spec = after.tasks.find((t: any) => t.title.startsWith("Write the one-page"));
  assert.equal(spec.estimateMinutes, null, "no invented estimate");
  assert.equal(after.tasks.find((t: any) => t.title.startsWith("Set up")).estimateMinutes, null, "the user never stated one, so it isn't kept");
});

test("discussing an idea is not permission: a reply with no project plan creates nothing", async () => {
  fakeReply({ message: "That could work. What would it replace?" });
  const r = await chat("I'm considering starting another product.");
  assert.equal(r.json.state.projects.length, 0);
  assert.equal(r.json.state.proposal, null);
});

test("invalid project plans are rejected by the app's checks, with no partial save", async () => {
  fakeReply({ project_plan: launch({ milestones: [{ id: "", ref: "m1", title: "Too late", target_date: "2027-06-01", remove: false }] }) });
  const r = await chat("plan my launch");
  assert.equal(r.json.state.proposal?.projectPlan ?? null, null);
  assert.equal(r.json.state.projects.length, 0);
  fakeReply({ project_plan: launch({ target_date: "2020-01-01" }) });
  assert.equal((await chat("again")).json.state.proposal?.projectPlan ?? null, null);
});

test("an existing project is revised, never duplicated", async () => {
  const p = await createLaunch();
  fakeReply({ project_plan: launch() });
  assert.equal((await chat("plan the launch again")).json.state.proposal?.projectPlan ?? null, null, "same title as new project is refused");
  fakeReply({
    project_plan: {
      project_id: p.id,
      title: p.title,
      goal: "",
      target_date: "2027-02-04",
      assumptions: [],
      dependencies: [],
      milestones: [
        { id: p.milestones[2].id, ref: "m3", title: "Launch", target_date: "2027-02-04", remove: false },
        { id: "", ref: "m4", title: "Gather feedback", target_date: "2027-02-04", remove: false },
      ],
      tasks: [{ ref: "t9", title: "Draft the launch post", milestone_ref: "m3", priority: "normal", estimate_minutes: 0 }],
      reason: "Pushed the launch by two weeks.",
    },
  });
  const r = await chat("The launch has to move two weeks.");
  assert.equal(r.json.state.projects[0].targetDate, "2027-01-21", "nothing changed yet");
  await api("POST", `/api/proposals/${r.json.state.proposal.id}/confirm`, {});
  const s = await state();
  assert.equal(s.projects.length, 1);
  assert.equal(s.projects[0].targetDate, "2027-02-04");
  assert.equal(s.projects[0].milestones.length, 4);
  assert.equal(s.tasks.length, 4);
});

test("progress comes from real task and milestone states and recorded time; milestones never complete themselves", async () => {
  const p = await createLaunch();
  const [t1, t2, t3] = ["Interview five", "Write the one-page", "Set up"].map((x) => (null as any, x));
  const tasks = (await state()).tasks;
  const interview = tasks.find((t: any) => t.title.startsWith(t1));
  const spec = tasks.find((t: any) => t.title.startsWith(t2));
  void t3;
  assert.deepEqual(p.progress.nextActionIds, [interview.id, spec.id, tasks.find((x: any) => x.title.startsWith("Set up")).id], "earliest milestone first, then priority");
  assert.equal(p.progress.tasksDone, 0);
  assert.equal(p.progress.workedMinutes, 0);
  // work and finish one task
  at("2026-10-21T09:00:00Z");
  await api("POST", `/api/tasks/${interview.id}/timer`, { action: "start" });
  at("2026-10-21T09:45:00Z");
  await api("POST", `/api/tasks/${interview.id}/finish`, {});
  let s = await state();
  assert.equal(s.projects[0].progress.tasksDone, 1);
  assert.equal(s.projects[0].progress.workedMinutes, 45);
  assert.equal(s.projects[0].progress.milestonesDone, 0, "finishing tasks doesn't mark the milestone done");
  assert.ok(!s.projects[0].progress.nextActionIds.includes(interview.id));
  // the user completes the milestone through chat (with Undo)
  fakeReply({ actions: [act("complete_milestone", { milestone_id: p.milestones[0].id })] });
  const r = await chat("Validation is finished");
  const rec = r.json.state.messages.at(-1).meta.receipts[0];
  assert.equal(rec.ok, true);
  assert.equal(r.json.state.projects[0].progress.milestonesDone, 1);
  const u = await api("POST", `/api/undo/${rec.undoId}`);
  assert.equal(u.json.state.projects[0].progress.milestonesDone, 0);
});

test("coming back days later: the project, its progress and its next actions are all still there", async () => {
  const p = await createLaunch();
  closeAll();
  at("2026-10-24T08:00:00Z");
  const s = await state();
  assert.equal(s.projects[0].id, p.id);
  assert.equal(s.projects[0].progress.nextActionIds.length, 3);
  // a milestone date passes: reported as overdue, not silently moved
  at("2026-11-06T08:00:00Z");
  const late = await state();
  assert.deepEqual(late.projects[0].progress.overdueMilestoneIds, [p.milestones[0].id]);
  assert.equal(late.projects[0].milestones[0].targetDate, "2026-11-04");
});

test("project tasks reach Today only when the user (or an approved action) assigns them", async () => {
  const p = await createLaunch();
  const next = p.progress.nextActionIds.slice(0, 2);
  fakeReply({ actions: next.map((id: string) => act("move_day", { task_id: id, date: "2026-10-21" })) });
  const s = (await chat("Put the first two on today")).json.state;
  assert.deepEqual(s.days[0].openIds.sort(), [...next].sort());
  assert.equal(s.projects[0].progress.unassigned, 1);
});

test("pause, resume, complete and archive are quick actions with Undo; a paused project suggests nothing", async () => {
  const p = await createLaunch();
  fakeReply({ actions: [act("pause_project", { project_id: p.id })] });
  const r = await chat("Pause the launch for now");
  assert.equal(r.json.state.projects[0].status, "paused");
  assert.deepEqual(r.json.state.projects[0].progress.nextActionIds, []);
  const rec = r.json.state.messages.at(-1).meta.receipts[0];
  assert.equal((await api("POST", `/api/undo/${rec.undoId}`)).json.state.projects[0].status, "active");
  fakeReply({ actions: [act("archive_project", { project_id: p.id })] });
  assert.equal((await chat("archive it")).json.state.projects[0].status, "archived");
  // archived projects can't take new tasks
  const t = (await api("POST", "/api/tasks", { title: "Loose task" })).json.task;
  assert.equal((await api("PATCH", `/api/tasks/${t.id}`, { projectId: p.id })).status, 409);
});

test("linking a task to a project goes through the same checks from the UI and from chat", async () => {
  const p = await createLaunch();
  const other = await createLaunchTwo();
  const t = (await api("POST", "/api/tasks", { title: "Loose task" })).json.task;
  const bad = await api("PATCH", `/api/tasks/${t.id}`, { projectId: p.id, milestoneId: other.milestones[0].id });
  assert.equal(bad.status, 400);
  fakeReply({ actions: [act("link_task", { task_id: t.id, project_id: p.id, milestone_id: other.milestones[0].id })] });
  const rec = (await chat("add it to the launch")).json.state.messages.at(-1).meta.receipts[0];
  assert.equal(rec.ok, false, "chat refuses for the same reason");
  const ok = await api("PATCH", `/api/tasks/${t.id}`, { projectId: p.id, milestoneId: p.milestones[1].id });
  assert.equal(ok.json.task.projectId, p.id);
  assert.equal(ok.json.task.project, "Launch the AI app");
});

async function createLaunchTwo() {
  fakeReply({ project_plan: launch({ title: "Grow consulting", goal: "More clients.", milestones: [{ id: "", ref: "m1", title: "Find leads", target_date: "2026-11-30", remove: false }], tasks: [] }) });
  const r = await chat("plan my consulting growth");
  await api("POST", `/api/proposals/${r.json.state.proposal.id}/confirm`, {});
  return (await state()).projects.find((x: any) => x.title === "Grow consulting");
}

test("a reminder can count down to the project's target date and follows it when it moves", async () => {
  const p = await createLaunch();
  fakeReply({ actions: [act("create_reminder", { title: "Launch is close", project_id: p.id, from_deadline: true, offset_days: 2 })] });
  const s = (await chat("Remind me two days before the project deadline")).json.state;
  assert.equal(s.reminders[0].localDate, "2027-01-19");
  fakeReply({
    project_plan: { project_id: p.id, title: p.title, goal: "", target_date: "2027-02-04", assumptions: [], dependencies: [], milestones: [], tasks: [], reason: "Moved." },
  });
  const r = await chat("Move the launch to February 4");
  await api("POST", `/api/proposals/${r.json.state.proposal.id}/confirm`, {});
  assert.equal((await state()).reminders[0].localDate, "2027-02-02");
});

test("project data survives an export-style full read and is isolated from the demo workspace", async () => {
  await createLaunch();
  const res = await fetch(base + "/api/state", { headers: { "x-workspace": "demo", "x-timezone": TZ } });
  assert.equal(((await res.json()) as any).state.projects.length, 0);
});
