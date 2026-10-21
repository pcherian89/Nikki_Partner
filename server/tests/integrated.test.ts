import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// One continuous story on one database, as a real user would live it over several days. Model replies are scripted
// (no API key here); everything the app does with them — validation, confirmation, persistence — is the real code.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-int-"));
process.env.DATABASE_PATH = path.join(tmp, "nikki.db");
process.env.ANTHROPIC_API_KEY = "";
process.env.NIKKI_FAKE_NOW = "2026-10-21T08:00:00Z"; // Wed 09:00 London (BST)

const { app } = await import("../index.js");
const { setProvider } = await import("../provider/index.js");
const { getDb, closeAll } = await import("../db.js");
const { tickReminders } = await import("../reminders.js");
const { setPushSender, deliverByPush } = await import("../push.js");

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

async function api(method: string, url: string, body?: unknown, client = "laptop") {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json", "x-workspace": "personal", "x-timezone": TZ, "x-client-id": client },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
const state = async (client = "laptop") => (await api("GET", "/api/state", undefined, client)).json.state;
const blank = { questions: [], quick_replies: [], captured_items: [], task_updates: [], actions: [], meetings: [], context_updates: [], memory_updates: [], project_plan: null, plan: null };
let seen = "";
const reply = (over: Record<string, unknown>) =>
  setProvider({ name: "fake", model: "fake", generate: async (req: any) => ((seen = req.messages.at(-1).content), { model: "fake", text: JSON.stringify({ ...blank, message: "ok", ...over }) }) });
const facts = () => JSON.parse(seen.split("<app_state>")[1].split("</app_state>")[0]).app_facts;
const chat = (text: string, kind = "chat") => api("POST", "/api/messages", { text, kind, clientRequestId: `req-${++rid}-xxxxxxxx` });
const confirm = (s: any, body: unknown = {}) => api("POST", `/api/proposals/${s.proposal.id}/confirm`, body);
const act = (type: string, over: Record<string, unknown> = {}) => ({ type, task_id: "", minutes: 0, from: "", to: "", date: "", time: "", priority: "", flag: false, ...over });
const item = (title: string, over: Record<string, unknown> = {}) => ({ ref: `n${++rid}`, kind: "action", title, notes: "", estimate_minutes: 0, deadline: "", deadline_time: "", planned_date: "", priority: "normal", optional: false, project: "", duplicate_of: "", ...over });
const mu = (over: Record<string, unknown>) => ({ op: "add", item_id: "", kind: "decision", text: "", status: "tentative", rationale: "", project_id: "", review_after: "", reason: "", ...over });

let projectId = "";
let projectTaskIds: string[] = [];

test("1–3. a three-month goal: Nikki asks one question, proposes milestones, nothing is saved until approval, then it is saved", async () => {
  reply({ questions: ["How many hours a week can you give it?"], message: "One question first." });
  const q = await chat("I want to build and launch an AI application over the next three months. Help me create a realistic plan.");
  assert.equal(q.json.state.projects.length, 0);
  reply({
    message: "Here is a plan with three milestones. Nothing is saved until you confirm.",
    project_plan: {
      project_id: "", title: "Launch the AI app", goal: "Build and launch an AI application in three months.", target_date: "2027-01-21",
      assumptions: ["About 10 hours a week"], dependencies: ["Choose the first use case"],
      milestones: [
        { id: "", ref: "m1", title: "Validate the idea", target_date: "2026-11-11", remove: false },
        { id: "", ref: "m2", title: "Build the prototype", target_date: "2026-12-16", remove: false },
        { id: "", ref: "m3", title: "Launch", target_date: "2027-01-21", remove: false },
      ],
      tasks: [
        { ref: "t1", title: "Interview five potential users", milestone_ref: "m1", priority: "high", estimate_minutes: 0 },
        { ref: "t2", title: "Write the one-page spec", milestone_ref: "m1", priority: "normal", estimate_minutes: 0 },
        { ref: "t3", title: "Set up the repository", milestone_ref: "m2", priority: "normal", estimate_minutes: 0 },
      ],
      reason: "A month per milestone.",
    },
  });
  const r = await chat("About ten hours a week.");
  assert.equal(r.json.state.projects.length, 0, "proposed, not saved");
  assert.equal(r.json.state.proposal.projectPlan.milestones.length, 3);
  assert.equal((await confirm(r.json.state)).status, 200);
  const s = await state();
  projectId = s.projects[0].id;
  projectTaskIds = s.projects[0].progress.nextActionIds;
  assert.equal(s.projects[0].status, "active");
  assert.equal(s.days[0].openIds.length, 0, "the project did not flood Today");
});

test("4–5. Nikki helps choose today's tasks; an unscheduled task is started and timed", async () => {
  reply({ message: "Two project tasks fit around your day.", actions: projectTaskIds.slice(0, 2).map((id) => act("move_day", { task_id: id, date: "2026-10-21" })) });
  const r = await chat("What should I work on today for the launch?");
  assert.deepEqual(r.json.state.messages.at(-1).meta.receipts.map((x: any) => x.ok), [true, true]);
  assert.equal(r.json.state.days[0].openIds.length, 2);
  // start the first (no plan exists at all)
  at("2026-10-21T08:15:00Z");
  const first = projectTaskIds[0];
  await api("POST", `/api/tasks/${first}/timer`, { action: "start" });
  at("2026-10-21T09:00:00Z");
  const p = await api("POST", `/api/tasks/${first}/timer`, { action: "stop" });
  assert.equal(p.json.state.tasks.find((t: any) => t.id === first).spentMinutes, 45);
  assert.equal(p.json.state.projects[0].progress.workedMinutes, 45);
  assert.equal(p.json.state.plan, null, "no schedule was ever needed");
});

test("6–7. an urgent commitment changes the day; the day is revised without losing any task", async () => {
  at("2026-10-21T09:30:00Z"); // 10:30 London
  reply({
    message: "Added both. The report is the priority now.",
    captured_items: [item("Finish the client report", { priority: "high", deadline: "2026-10-21", deadline_time: "17:00", planned_date: "2026-10-21", estimate_minutes: 120 })],
    meetings: [{ date: "2026-10-21", title: "Client call", start: "15:00", end: "16:00" }],
  });
  const r = await chat("Urgent: the client report is due at 5 PM today, about 2 hours, and I have a client call at 3.");
  const s = r.json.state;
  const report = s.tasks.find((t: any) => t.title === "Finish the client report");
  assert.equal(report.priority, "high");
  assert.equal(report.deadlineTime, "17:00");
  assert.equal(report.estimateMinutes, 120, "the user stated the duration");
  assert.equal(s.days[0].openIds.length, 3);
  assert.equal(s.plan, null);
  // replan the day around the call (the model schedules the report first and leaves one task unscheduled)
  const meeting = (await state()).meetings[0];
  const idOther = projectTaskIds[1];
  reply({
    message: "Report first, then the call.",
    plan: {
      date: "2026-10-21", main_outcome: "Client report", focus: { task_ref: report.id, why: "Due at 5 PM" }, supporting: [], deferred: [{ task_ref: idOther, why: "No estimate and no room before the call." }],
      window: { start: "09:00", end: "17:30" }, work_budget_minutes: 120,
      blocks: [
        { start: "10:30", end: "12:30", kind: "focus", task_ref: report.id, title: "Client report", pinned: false },
        { start: "15:00", end: "16:00", kind: "meeting", task_ref: "", title: "Client call", pinned: false },
      ],
      reasons: [], assumptions: [],
    },
  });
  const rp = await chat("Plan my day around that.");
  assert.ok(meeting.id);
  const planDraft = rp.json.state.proposal.plan;
  assert.ok(planDraft.blocks.some((b: any) => b.kind === "meeting"));
  assert.equal((await confirm(rp.json.state)).status, 200);
  const after = await state();
  assert.equal(after.days[0].openIds.length, 3, "no task was lost, scheduled or not");
  assert.ok(after.days[0].openIds.includes(idOther), "the unscheduled task is still on today's list");
});

test("8. a reminder is created from chat and fires; closed-app push counts as verified only after the device confirms", async () => {
  reply({ actions: [act("create_reminder", { title: "Follow up on the proposal", date: "2026-10-22", time: "09:00" })] });
  const r = await chat("Remind me tomorrow morning to follow up on the proposal.");
  assert.equal(r.json.state.reminders[0].localTime, "09:00");
  assert.equal(r.json.state.tasks.filter((t: any) => /follow up/i.test(t.title)).length, 0, "a reminder is not a task");
  await api("POST", "/api/push/subscribe", { endpoint: "https://push.example.test/x", keys: { p256dh: "k", auth: "a" } });
  const sent: any[] = [];
  setPushSender(async (_s, payload) => (sent.push(JSON.parse(payload)), { statusCode: 201 }));
  assert.equal((await state()).notifications.verified, false);
  at("2026-10-21T14:00:00Z");
  await api("POST", "/api/push/test");
  at("2026-10-21T14:00:03Z");
  await api("POST", "/api/push/ack");
  assert.equal((await state()).notifications.verified, true);
  at("2026-10-22T08:00:30Z"); // 09:00:30 London next day
  const fired = await tickReminders(getDb("personal"), TZ, deliverByPush(getDb("personal")));
  assert.deepEqual(fired[0].channels, ["in-app", "push"]);
  assert.equal(sent.at(-1).body, "Follow up on the proposal");
  assert.equal((await state()).reminders[0].status, "due");
  setPushSender(null);
});

test("9–12. a new opportunity: Nikki weighs it against stored priorities and real progress; the user approves a decision; the app applies it", async () => {
  at("2026-10-22T10:00:00Z");
  await api("POST", "/api/memory", { kind: "priority", text: "Finish the client report work before anything new" });
  await api("POST", "/api/memory", { kind: "constraint", text: "About 10 hours a week for the launch project" });
  await api("POST", "/api/memory", { kind: "idea", text: "Maybe offer consulting workshops", status: "tentative" });
  reply({
    message: "Taking it would roughly double your load against about ten free hours a week, and the launch's first milestone is due in under three weeks. I'd lean towards declining or deferring unless it pays much more than the report work. What I don't know: the rate and the time it needs.",
    questions: ["What are the hours and the rate?"],
  });
  const ask = await chat("Should I accept another consulting engagement from a new client?");
  const f = facts();
  assert.ok(f.strategy.items.some((i: any) => /client report/.test(i.text)), "stored priorities reach the model");
  assert.ok(f.strategy.items.some((i: any) => /10 hours/.test(i.text)));
  assert.ok(f.projects.active_and_paused[0].progress.minutes_recorded >= 45, "real recorded time reaches the model");
  assert.ok(f.projects.active_and_paused[0].progress.minutes_last_14_days >= 45);
  assert.equal(ask.json.state.proposal, null, "discussing it changed nothing");
  assert.equal(ask.json.state.projects[0].targetDate, "2027-01-21");
  // the user decides: defer the engagement and keep the launch on track
  reply({
    message: "Noted. I'll record the decision and push the prototype milestone by a week to leave room for the report work.",
    memory_updates: [mu({ kind: "decision", text: "Defer the new consulting engagement until the first launch milestone is done", status: "approved", rationale: "Roughly ten hours a week; milestone one due 11 Nov.", review_after: "2026-11-15" })],
    project_plan: { project_id: projectId, title: "Launch the AI app", goal: "", target_date: "", assumptions: [], dependencies: [], milestones: [{ id: (await state()).projects[0].milestones[1].id, ref: "m2", title: "Build the prototype", target_date: "2026-12-23", remove: false }], tasks: [], reason: "Pushed by a week." },
  });
  const dec = await chat("Yes, defer it, and push the prototype by a week.");
  assert.equal(dec.json.state.memory.filter((m: any) => m.kind === "decision").length, 0, "not stored before the user confirms");
  assert.equal(dec.json.state.projects[0].milestones[1].targetDate, "2026-12-16", "not changed before the user confirms");
  assert.equal((await confirm(dec.json.state)).status, 200);
  const s = await state();
  const decision = s.memory.find((m: any) => m.kind === "decision");
  assert.equal(decision.status, "approved");
  assert.equal(s.projects[0].milestones[1].targetDate, "2026-12-23");
});

test("13. days later, after a restart, Nikki still has the context", async () => {
  closeAll();
  at("2026-10-25T09:00:00Z");
  reply({});
  await chat("Where did we get to?");
  const f = facts();
  assert.ok(f.strategy.items.some((i: any) => i.kind === "decision" && /Defer the new consulting/.test(i.text)));
  assert.equal(f.projects.active_and_paused[0].target_date, "2027-01-21");
  assert.ok(f.reminders.length >= 1, "the due reminder is still there");
  const s = await state();
  assert.equal(s.reminders[0].status, "due");
});

test("14–15. the weekly review separates what was done, what wasn't, project progress and what can't be known", async () => {
  at("2026-10-25T09:00:00Z");
  await api("PATCH", `/api/tasks/${projectTaskIds[1]}`, { status: "done" }); // finished without any recorded time
  reply({ message: "A modest week on the launch; the client report landed." });
  const r = await chat("Weekly review", "weekly_review");
  const w = r.json.state.messages.at(-1).meta.weekly;
  // completed work: only what was really finished, with its recorded time (none for the spec)
  assert.deepEqual(w.completed.map((c: any) => [c.title, c.minutes]), [["Write the one-page spec", 0]]);
  // unfinished: planned in the week, still open (the report was never marked done), kept separate from completed
  assert.ok(w.unfinished.some((t: any) => t.title === "Finish the client report"));
  assert.ok(!w.unfinished.some((t: any) => t.title === "Write the one-page spec"));
  // project progress comes from records: 45 recorded minutes, one task done, none claimed for milestones
  const proj = w.projects[0];
  assert.equal(proj.minutesThisWeek, 45);
  assert.equal(proj.tasksDoneThisWeek, 1);
  assert.equal(proj.milestonesDoneThisWeek, 0);
  assert.equal(w.recordedMinutes, 45);
  // assumptions and unknowns are stated as limits, not blended into results
  assert.ok(w.dataGaps.some((g: string) => /no recorded time/.test(g)));
  assert.ok(w.dataGaps.some((g: string) => /no estimate/.test(g)));
  assert.deepEqual(w.decisionsThisWeek.map((d: any) => d.text), ["Defer the new consulting engagement until the first launch milestone is done"]);
  assert.equal(r.json.state.proposal, null, "a review changes nothing");
  assert.match(seen, /"weekly"/);
});

test("failures and edge cases: stale proposal, ambiguous request, other device, wrong timezone assumption", async () => {
  // ambiguous: Nikki asks instead of acting
  reply({ message: "Which one do you mean?", questions: ["Which report?"] });
  const amb = await chat("Finish the report");
  assert.equal(amb.json.state.proposal, null);
  assert.equal(amb.json.state.messages.at(-1).meta.receipts, undefined);
  // stale: a proposal made before the plan changed is refused, not half-applied
  const t = (await api("POST", "/api/tasks", { title: "Edge task", estimateMinutes: 30 })).json.task;
  at("2026-10-25T09:05:00Z");
  reply({ plan: { date: "2026-10-25", main_outcome: "Edge", focus: { task_ref: t.id, why: "" }, supporting: [], deferred: [], window: { start: "10:30", end: "17:00" }, work_budget_minutes: 30, blocks: [{ start: "11:00", end: "11:30", kind: "task", task_ref: t.id, title: "Edge", pinned: false }], reasons: [], assumptions: [] } });
  const first = await chat("plan");
  reply({ plan: { date: "2026-10-25", main_outcome: "Edge", focus: { task_ref: t.id, why: "" }, supporting: [], deferred: [], window: { start: "10:30", end: "17:00" }, work_budget_minutes: 30, blocks: [{ start: "12:00", end: "12:30", kind: "task", task_ref: t.id, title: "Edge", pinned: false }], reasons: [], assumptions: [] } });
  const second = await chat("plan again");
  assert.equal((await confirm(second.json.state)).status, 200);
  assert.equal((await api("POST", `/api/proposals/${first.json.state.proposal.id}/confirm`, {})).status, 409, "the older proposal is stale");
  // another device sees a timer it didn't start
  await api("POST", `/api/tasks/${t.id}/timer`, { action: "start" }, "phone");
  assert.equal((await state("laptop")).running.doubt, "other_device");
  assert.equal((await state("phone")).running.doubt, null);
  // the same moment is a different local time in another timezone; reminders keep the user's own
  const r = await api("POST", "/api/reminders", { title: "tz check", date: "2026-11-02", time: "09:00" });
  assert.equal(r.json.reminder.remindAt, "2026-11-02T09:00:00.000Z", "after the clocks go back, 09:00 London is 09:00 UTC");
});
