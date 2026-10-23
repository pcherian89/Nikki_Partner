import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-stagec-"));
process.env.DATABASE_PATH = path.join(tmp, "nikki.db");
process.env.ANTHROPIC_API_KEY = "";
process.env.NIKKI_FAKE_NOW = "2026-10-21T10:00:00Z";

const { app } = await import("../index.js");
const { setProvider } = await import("../provider/index.js");
const { getDb, wipe, savePlanVersion } = await import("../db.js");

const DAY = "2026-10-21";
const TOMORROW = "2026-10-22";
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

async function api(method: string, url: string, body?: unknown, client = "dev-a") {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json", "x-workspace": "personal", "x-timezone": "UTC", "x-client-id": client },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
const state = async (client = "dev-a") => (await api("GET", "/api/state", undefined, client)).json.state;
const mk = async (body: Record<string, unknown>) => (await api("POST", "/api/tasks", body)).json.task;
const mins = async (id: string) => (await state()).tasks.find((t: any) => t.id === id).spentMinutes;

const blank = { questions: [], quick_replies: [], captured_items: [], task_updates: [], actions: [], meetings: [], context_updates: [], plan: null };
function fakeReply(over: Record<string, unknown>) {
  setProvider({ name: "fake", model: "fake", generate: async () => ({ model: "fake", text: JSON.stringify({ ...blank, message: "ok", ...over }) }) });
}
const chat = (text: string) => api("POST", "/api/messages", { text, kind: "chat", clientRequestId: `req-${++rid}-xxxxxxxx` });
const item = (title: string, over: Record<string, unknown> = {}) => ({ ref: `n${++rid}`, kind: "action", title, notes: "", estimate_minutes: 0, deadline: "", deadline_time: "", planned_date: "", priority: "normal", optional: false, project: "", duplicate_of: "", ...over });
const act = (type: string, task_id: string, over: Record<string, unknown> = {}) => ({ type, task_id, minutes: 0, from: "", to: "", date: "", time: "", priority: "", flag: false, ...over });

test("capture: a task needs only a title; day, priority and deadline are independent and create no schedule", async () => {
  const t = await mk({ title: "Prepare the presentation", plannedDate: DAY, priority: "high", deadline: DAY, deadlineTime: "17:00" });
  assert.equal(t.priority, "high");
  assert.equal(t.estimateMinutes, null, "unknown estimate stays unknown");
  assert.equal(t.plannedDate, DAY);
  const plain = await mk({ title: "Plain" });
  assert.equal(plain.priority, "normal");
  assert.equal(plain.optional, false);
  const s = await state();
  assert.equal(s.plan, null, "no block was created");
  assert.ok(s.days.find((d: any) => d.date === DAY).openIds.includes(t.id), "it is on today's list");
  assert.equal(s.taskMeta[t.id].deadlineStatus, "no_estimate", "no estimate: never reported as at risk");
});

test("deadline: at risk when remaining effort does not fit; priority does not hide it", async () => {
  at("15:00");
  const t = await mk({ title: "Tender", plannedDate: DAY, priority: "low", deadline: DAY, deadlineTime: "16:00", estimateMinutes: 120 });
  const s = await state();
  assert.equal(s.taskMeta[t.id].deadlineStatus, "at_risk");
  assert.ok(s.taskMeta[t.id].shortByMinutes >= 60);
  assert.equal(s.suggestion.taskId, t.id, "at-risk work comes first even though it is Low priority");
  const hi = await mk({ title: "Nice", plannedDate: DAY, priority: "high" });
  assert.notEqual((await state()).suggestion.taskId, hi.id);
  at("17:00");
  assert.equal((await state()).taskMeta[t.id].deadlineStatus, "overdue");
});

test("timer: start without a schedule, pause, resume = separate sessions, paused time not counted", async () => {
  const t = await mk({ title: "Report", plannedDate: DAY, estimateMinutes: 90 });
  await api("POST", `/api/tasks/${t.id}/timer`, { action: "start" });
  at("10:30");
  await api("POST", `/api/tasks/${t.id}/timer`, { action: "stop" });
  at("11:00");
  await api("POST", `/api/tasks/${t.id}/timer`, { action: "start" });
  at("11:15");
  await api("POST", `/api/tasks/${t.id}/timer`, { action: "stop" });
  const s = await state();
  assert.deepEqual(s.sessions.map((x: any) => x.minutes), [30, 15]);
  assert.equal(s.taskMeta[t.id].workedMinutes, 45);
  assert.equal(s.taskMeta[t.id].remainingMinutes, 45);
  assert.equal(s.taskMeta[t.id].sessionCount, 2);
});

test("timer: a second timer is refused with a choice; finish-and-start finishes the first", async () => {
  const a = await mk({ title: "A" });
  const b = await mk({ title: "B" });
  await api("POST", `/api/tasks/${a.id}/timer`, { action: "start" });
  const r = await api("POST", `/api/tasks/${b.id}/timer`, { action: "start" });
  assert.equal(r.status, 409);
  assert.equal(r.json.data.runningTaskId, a.id);
  at("10:20");
  const ok = await api("POST", `/api/tasks/${b.id}/timer`, { action: "start", switch: "finish" });
  const tasks = ok.json.state.tasks;
  assert.equal(tasks.find((x: any) => x.id === a.id).status, "done");
  assert.equal(tasks.find((x: any) => x.id === a.id).spentMinutes, 20);
  assert.ok(tasks.find((x: any) => x.id === b.id).timerStartedAt);
  assert.equal(ok.json.state.running.taskId, b.id);
});

test("finish without any timer invents no time", async () => {
  const t = await mk({ title: "Quick call", estimateMinutes: 30 });
  const r = await api("PATCH", `/api/tasks/${t.id}`, { status: "done" });
  assert.equal(r.json.task.status, "done");
  assert.equal(r.json.task.spentMinutes, 0);
  assert.equal(r.json.state.sessions.length, 0);
});

test("forgot to start: add time worked; exact duplicates and overlaps are caught", async () => {
  const t = await mk({ title: "Report" });
  const u = await mk({ title: "Other" });
  at("12:00");
  const ok = await api("POST", `/api/tasks/${t.id}/time`, { from: "09:00", to: "10:00" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.session.source, "reported");
  assert.equal(await mins(t.id), 60);
  const dup = await api("POST", `/api/tasks/${t.id}/time`, { from: "09:00", to: "10:00" });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.data.kind, "duplicate");
  const over = await api("POST", `/api/tasks/${u.id}/time`, { from: "09:30", to: "10:30" });
  assert.equal(over.status, 409);
  assert.equal(over.json.data.kind, "overlap");
  assert.equal((await api("POST", `/api/tasks/${u.id}/time`, { from: "09:30", to: "10:30", force: true })).status, 200);
  assert.equal((await api("POST", `/api/tasks/${t.id}/time`, { from: "13:00", to: "14:00" })).status, 400, "future time refused");
  const mins40 = await api("POST", `/api/tasks/${u.id}/time`, { minutes: 40 });
  assert.equal(mins40.status, 200);
});

test("forgotten timer: long run is saved 'needs a check', excluded from totals until confirmed or corrected", async () => {
  const t = await mk({ title: "Report", estimateMinutes: 60 });
  at("09:00");
  await api("POST", `/api/tasks/${t.id}/timer`, { action: "start" });
  at("18:00");
  const mid = await state();
  assert.ok(mid.running.doubt, "the app says this timer can't be trusted");
  const stop = await api("POST", `/api/tasks/${t.id}/timer`, { action: "stop" });
  assert.equal(stop.json.session.verified, false);
  let s = stop.json.state;
  assert.equal(s.tasks.find((x: any) => x.id === t.id).spentMinutes, 0, "not counted");
  assert.equal(s.checks.length, 1);
  assert.equal(s.checks[0].minutes, 540);
  const fixed = await api("PATCH", `/api/sessions/${s.checks[0].id}`, { minutes: 75 });
  s = fixed.json.state;
  assert.equal(s.checks.length, 0);
  assert.equal(s.tasks.find((x: any) => x.id === t.id).spentMinutes, 75);
  assert.ok(s.sessions.some((x: any) => x.minutes === 75 && x.verified));
});

test("timer started on another device is flagged to this one, never auto-verified; 'still working' takes it over", async () => {
  const t = await mk({ title: "Report", estimateMinutes: 480 });
  await api("POST", `/api/tasks/${t.id}/timer`, { action: "start" }, "phone");
  at("10:10");
  assert.equal((await state("phone")).running.doubt, null, "own device: fine");
  const other = await state("laptop");
  assert.equal(other.running.doubt, "other_device");
  await api("POST", `/api/tasks/${t.id}/still-working`, undefined, "laptop");
  assert.equal((await state("laptop")).running.doubt, null);
});

test("chat actions: receipts are the record; Undo restores; failures are real", async () => {
  const a = await mk({ title: "Insurance tender", plannedDate: DAY });
  const b = await mk({ title: "Weekly report", plannedDate: DAY });
  fakeReply({ message: "Done!", actions: [act("set_priority", a.id, { priority: "high" }), act("pause", b.id), act("start", a.id)] });
  const r = await chat("Insurance tender is my top priority, and start it");
  const receipts = r.json.state.messages.at(-1).meta.receipts;
  assert.equal(receipts.length, 3);
  assert.equal(receipts[0].ok, true);
  assert.equal(receipts[1].ok, false, "pausing a timer that isn't running is reported, not faked");
  assert.equal(receipts[2].ok, true);
  assert.equal(r.json.state.tasks.find((t: any) => t.id === a.id).priority, "high");
  const undo = await api("POST", `/api/undo/${receipts[0].undoId}`);
  assert.equal(undo.json.state.tasks.find((t: any) => t.id === a.id).priority, "normal");
  // The failure is in the history the model sees next turn.
  let seen = "";
  setProvider({ name: "fake", model: "fake", generate: async (req: any) => ((seen = JSON.stringify(req.messages)), { model: "fake", text: JSON.stringify({ ...blank, message: "ok" }) }) });
  await chat("anything");
  assert.match(seen, /NOT done/);
});

test("chat: several tasks at once with one Undo; no invented estimates; duplicates are not recreated", async () => {
  fakeReply({ captured_items: [item("Call bank", { planned_date: TOMORROW }), item("Send invoices", { priority: "high" }), item("Book flights", { optional: true })] });
  const r = await chat("Add three tasks");
  const s = r.json.state;
  const added = s.tasks.filter((t: any) => ["Call bank", "Send invoices", "Book flights"].includes(t.title));
  assert.equal(added.length, 3);
  assert.ok(added.every((t: any) => t.estimateMinutes === null));
  assert.equal(added.find((t: any) => t.title === "Call bank").plannedDate, TOMORROW);
  assert.equal(added.find((t: any) => t.title === "Book flights").optional, true);
  const receipt = s.messages.at(-1).meta.receipts[0];
  assert.match(receipt.text, /Added 3 tasks/);
  fakeReply({ captured_items: [item("Call bank")] });
  const again = await chat("add call bank");
  assert.equal(again.json.state.tasks.filter((t: any) => t.title === "Call bank").length, 1);
  const undo = await api("POST", `/api/undo/${receipt.undoId}`);
  assert.ok(!undo.json.state.tasks.some((t: any) => t.title === "Send invoices"));
});

test("chat: finish, report time, deadline in the past is refused, moving a task with blocks needs a preview", async () => {
  const a = await mk({ title: "Presentation", plannedDate: DAY, estimateMinutes: 60 });
  const b = await mk({ title: "Review", plannedDate: DAY, estimateMinutes: 60 });
  fakeReply({ actions: [act("report_time", a.id, { from: "08:00", to: "09:00" }), act("finish", a.id), act("set_deadline", b.id, { date: DAY, time: "09:00" })] });
  const r = await chat("I worked on the presentation 8 to 9 and finished it");
  const rec = r.json.state.messages.at(-1).meta.receipts;
  assert.deepEqual(rec.map((x: any) => x.ok), [true, true, false]);
  const task = r.json.state.tasks.find((t: any) => t.id === a.id);
  assert.equal(task.status, "done");
  assert.equal(task.spentMinutes, 60);
  // blocks on the task → preview, not a silent move
  const version = 0;
  savePlanVersion(getDb("personal"), {
    date: DAY, mainOutcome: "", focusTaskId: null, focusWhy: "", supporting: [], deferred: [], reasons: [], assumptions: [], window: { start: "09:00", end: "17:00" }, workBudgetMinutes: 60,
    blocks: [{ id: "bx", start: "13:00", end: "14:00", kind: "task", taskId: b.id, meetingId: null, title: "Review" }],
  } as any, { expectedVersion: version, proposalId: null, source: "user-edit" });
  fakeReply({ actions: [act("move_day", b.id, { date: TOMORROW })] });
  const m = await chat("Move the review to tomorrow");
  const mr = m.json.state.messages.at(-1).meta.receipts[0];
  assert.equal(mr.ok, false);
  assert.equal(mr.needsPreview, true);
  assert.equal(m.json.state.tasks.find((t: any) => t.id === b.id).plannedDate, DAY, "nothing moved");
});

test("a task assigned to a day without blocks moves immediately (with Undo)", async () => {
  const t = await mk({ title: "Review", plannedDate: DAY });
  fakeReply({ actions: [act("move_day", t.id, { date: TOMORROW })] });
  const r = await chat("Move review to tomorrow");
  assert.equal(r.json.state.tasks.find((x: any) => x.id === t.id).plannedDate, TOMORROW);
  const rec = r.json.state.messages.at(-1).meta.receipts[0];
  assert.ok(rec.undoId);
  const u = await api("POST", `/api/undo/${rec.undoId}`);
  assert.equal(u.json.state.tasks.find((x: any) => x.id === t.id).plannedDate, DAY);
});

test("unscheduled tasks stay on today's list and in the day summary; unknown estimates are counted separately", async () => {
  await mk({ title: "A", plannedDate: DAY, estimateMinutes: 60 });
  await mk({ title: "B", plannedDate: DAY });
  const s = await state();
  const today = s.days.find((d: any) => d.date === DAY);
  assert.equal(today.openIds.length, 2);
  assert.equal(today.remainingMinutes, 60);
  assert.equal(today.unknownEstimates, 1);
});

test("history: finishing a task does not mark earlier blocks done", async () => {
  const t = await mk({ title: "Deck", plannedDate: DAY, estimateMinutes: 60 });
  savePlanVersion(getDb("personal"), {
    date: DAY, mainOutcome: "", focusTaskId: null, focusWhy: "", supporting: [], deferred: [], reasons: [], assumptions: [], window: { start: "09:00", end: "17:00" }, workBudgetMinutes: 60,
    blocks: [{ id: "b1", start: "09:00", end: "10:00", kind: "task", taskId: t.id, meetingId: null, title: "Deck" }],
  } as any, { expectedVersion: 0, proposalId: null, source: "user-edit" });
  await api("PATCH", `/api/tasks/${t.id}`, { status: "done" });
  const s = await state();
  assert.deepEqual(s.history.map((h: any) => h.status), ["unconfirmed"]);
});

// ---------- Stage C completion ----------

const { closeAll } = await import("../db.js");
const planReply = (blocks: any[], over: Record<string, unknown> = {}) => ({
  date: DAY,
  main_outcome: "Day",
  focus: { task_ref: blocks.find((b) => b.task_ref)?.task_ref ?? "", why: "" },
  supporting: [],
  deferred: [],
  window: { start: "10:00", end: "17:00" },
  work_budget_minutes: blocks.filter((b) => b.task_ref).reduce((a, b) => a + (Number(b.end.slice(0, 2)) * 60 + Number(b.end.slice(3)) - Number(b.start.slice(0, 2)) * 60 - Number(b.start.slice(3))), 0),
  blocks,
  reasons: [],
  assumptions: [],
  ...over,
});
const blk = (start: string, end: string, task_ref: string, over: Record<string, unknown> = {}) => ({ start, end, kind: "task", task_ref, title: "Work", pinned: false, ...over });
const confirm = async (state: any) => (await api("POST", `/api/proposals/${state.proposal.id}/confirm`, {})).json;

test("pinned: a time the user states is kept by later replans and overlaps are rejected", async () => {
  const a = await mk({ title: "Call the bank", estimateMinutes: 30 });
  const b = await mk({ title: "Report", estimateMinutes: 60 });
  fakeReply({ plan: planReply([blk("14:00", "14:30", a.id, { pinned: true }), blk("11:00", "12:00", b.id)]) });
  const r = await chat("Call the bank at 2, then do the report");
  const c = await confirm(r.json.state);
  const plan = c.state?.plan ?? (await state()).plan;
  assert.equal(plan.blocks.find((x: any) => x.taskId === a.id).pinned, true);
  // Model replans and forgets the pinned block: it is put back.
  at("12:30");
  fakeReply({ plan: planReply([blk("12:30", "13:30", b.id)], { window: { start: "10:00", end: "17:00" } }) });
  const r2 = await api("POST", "/api/replan", { clientRequestId: `req-${++rid}-xxxxxxxx`, remainingUntil: "17:00" });
  const c2 = await confirm(r2.json.state);
  const p2 = (await state()).plan;
  assert.ok(p2.blocks.some((x: any) => x.taskId === a.id && x.start === "14:00" && x.pinned), "pinned block survived the replan");
  // Model tries to overlap it: the app's checks reject the plan (reported, not applied).
  fakeReply({ plan: planReply([blk("13:45", "14:45", b.id)]) });
  const r3 = await api("POST", "/api/replan", { clientRequestId: `req-${++rid}-xxxxxxxx`, remainingUntil: "17:00" });
  assert.equal(r3.json.state.proposal?.plan ?? null, null, "no plan proposed that moves the pinned block");
  void c2;
});

test("pinned: editing a block's time by hand pins it", async () => {
  const a = await mk({ title: "Report", estimateMinutes: 60 });
  const s0 = await state();
  const d = { mainOutcome: "", focusTaskId: null, focusWhy: "", supporting: [], deferred: [], reasons: [], assumptions: [], window: { start: "10:00", end: "17:00" }, workBudgetMinutes: 60, blocks: [{ id: "b1", start: "11:00", end: "12:00", kind: "task", taskId: a.id, meetingId: null, title: "Report" }] };
  assert.equal((await api("PUT", "/api/plan", { expectedVersion: 0, plan: d, date: DAY })).status, 200);
  const v1 = (await state()).plan;
  assert.ok(!v1.blocks[0].pinned);
  d.blocks[0].start = "13:00";
  d.blocks[0].end = "14:00";
  await api("PUT", "/api/plan", { expectedVersion: v1.version, plan: d, date: DAY });
  assert.equal((await state()).plan.blocks[0].pinned, true);
  void s0;
});

test("estimates: the model cannot invent one; a stated duration is kept; unestimated blocks are provisional", async () => {
  fakeReply({ captured_items: [item("Write proposal", { estimate_minutes: 90 })] });
  await chat("add write proposal");
  let t = (await state()).tasks.find((x: any) => x.title === "Write proposal");
  assert.equal(t.estimateMinutes, null);
  fakeReply({ captured_items: [item("Draft email", { estimate_minutes: 60 })] });
  await chat("add draft email, about an hour");
  t = (await state()).tasks.find((x: any) => x.title === "Draft email");
  assert.equal(t.estimateMinutes, 60);
  const wp = (await state()).tasks.find((x: any) => x.title === "Write proposal");
  fakeReply({ plan: planReply([blk("11:00", "12:00", wp.id)]) });
  const r = await chat("plan my day");
  const draft = r.json.state.proposal.plan;
  assert.equal(draft.blocks[0].provisional, true, "a block for an unestimated task is labelled provisional");
  await confirm(r.json.state);
  assert.equal((await state()).tasks.find((x: any) => x.id === wp.id).estimateMinutes, null, "the task still has no estimate");
});

test("overrun: keeping going shows what it touches; extending shifts flexible work around fixed items", async () => {
  const a = await mk({ title: "Deck", estimateMinutes: 60 });
  const b = await mk({ title: "Report", estimateMinutes: 60 });
  const c = await mk({ title: "Review", estimateMinutes: 30 });
  await api("POST", "/api/meetings", { title: "Client call", date: DAY, start: "11:45", end: "12:30" });
  fakeReply({ plan: planReply([blk("10:00", "11:00", a.id), blk("11:00", "11:45", c.id), { start: "11:45", end: "12:30", kind: "meeting", task_ref: "", title: "Client call", pinned: false }, blk("12:30", "13:30", b.id)]) });
  const r = await chat("plan");
  const pid = r.json.state.proposal.id;
  const meetingId = r.json.state.proposal.plan.blocks.find((x: any) => x.kind === "meeting").meetingId;
  assert.ok(meetingId, "proposal references the saved meeting");
  await api("POST", `/api/proposals/${pid}/confirm`, {});
  at("10:00");
  await api("POST", `/api/tasks/${a.id}/timer`, { action: "start" });
  at("11:05");
  const none = (await api("GET", `/api/tasks/${c.id}/overrun`)).json.preview;
  assert.equal(none.needed, false, "not running past a block it owns");
  const p = (await api("GET", `/api/tasks/${a.id}/overrun?minutes=30`)).json.preview;
  assert.equal(p.needed, true);
  assert.equal(p.fixed, null, "30 minutes doesn't reach the meeting");
  assert.equal(p.shifted.length, 2, "flexible work moves later, around the meeting");
  const long = (await api("GET", `/api/tasks/${a.id}/overrun?minutes=60`)).json.preview;
  assert.equal(long.fixed.title, "Client call");
  assert.equal(long.capped, true, "a long extension stops at the meeting");
  assert.equal(long.newEnd, "11:45");
  const before = (await state()).plan.version;
  const ap = await api("POST", `/api/tasks/${a.id}/overrun`, { minutes: 30 });
  assert.equal(ap.status, 200);
  const plan = ap.json.state.plan;
  assert.equal(plan.version, before + 1, "a new plan version; the old one stays in history");
  const meeting = plan.blocks.find((x: any) => x.kind === "meeting");
  assert.equal(meeting.start, "11:45", "the meeting never moves");
  const deck = plan.blocks.find((x: any) => x.taskId === a.id);
  assert.equal(deck.end, "11:35");
  assert.ok(plan.blocks.filter((x: any) => x.kind === "task" && x.taskId !== a.id).every((x: any) => x.start >= "12:30"), "nothing overlaps the meeting");
});

test("end of day: wrap-up changes nothing unless the user chooses; completion never invents sessions", async () => {
  const a = await mk({ title: "Deck", plannedDate: DAY, estimateMinutes: 60 });
  const b = await mk({ title: "Report", plannedDate: DAY });
  fakeReply({ plan: planReply([blk("11:00", "12:00", a.id)]) });
  const r = await chat("plan");
  await confirm(r.json.state);
  await api("PATCH", `/api/tasks/${a.id}`, { status: "done" });
  const s1 = await state();
  assert.equal(s1.sessions.length, 0, "no work session was invented for a finished task");
  assert.equal(s1.tasks.find((t: any) => t.id === a.id).spentMinutes, 0);
  const w = await api("POST", "/api/wrapup", { decisions: [{ taskId: b.id, action: "keep" }], note: "" });
  assert.equal(w.status, 200);
  const after = w.json.state.tasks.find((t: any) => t.id === b.id);
  assert.equal(after.plannedDate, DAY, "kept on today, not moved");
  assert.equal(after.status, "open");
});

test("persistence: a running timer survives a server restart and is the same on every device", async () => {
  const t = await mk({ title: "Report", estimateMinutes: 600 });
  await api("POST", `/api/tasks/${t.id}/timer`, { action: "start" }, "phone");
  closeAll();
  at("10:30");
  const s = await state("laptop");
  assert.equal(s.running.taskId, t.id);
  assert.equal(s.running.minutes, 30);
  assert.equal(s.running.startedAt, `${DAY}T10:00:00.000Z`.replace("T10:00", "T10:00"));
});

test("parity: a button and chat refuse the same things for the same reason", async () => {
  const t = await mk({ title: "Report", plannedDate: DAY });
  const ui = await api("PATCH", `/api/tasks/${t.id}`, { deadline: DAY, deadlineTime: "09:00" });
  assert.equal(ui.status, 400);
  fakeReply({ actions: [act("set_deadline", t.id, { date: DAY, time: "09:00" })] });
  const r = await chat("deadline 9am today");
  const rec = r.json.state.messages.at(-1).meta.receipts[0];
  assert.equal(rec.ok, false);
  assert.ok(rec.text.includes(ui.json.error), "same rule, same message");
  const ui2 = await api("PATCH", `/api/tasks/${t.id}`, { plannedDate: "2020-01-01" });
  assert.equal(ui2.status, 400);
});

test("adding tasks in chat never schedules them: a plan the user didn't ask for is dropped, with no times or estimates", async () => {
  fakeReply({
    message: "Added.",
    captured_items: [item("Medical conference final report"), item("Financial proposal")],
    plan: planReply([blk("10:00", "11:30", "n1"), blk("11:45", "13:15", "n2")]),
  });
  const r = await chat("Add: medical conference final report, financial proposal");
  const s = r.json.state;
  assert.equal(s.tasks.length, 2);
  assert.equal(s.proposal, null, "no plan proposed");
  assert.ok(s.tasks.every((t: any) => t.estimateMinutes === null));
  assert.equal(s.plan, null);
  // but when asked, a plan is proposed as before
  fakeReply({ captured_items: [item("Third thing")], plan: planReply([blk("10:00", "11:00", s.tasks[0].id)]) });
  assert.ok((await chat("Plan my day please, and add: third thing")).json.state.proposal?.plan);
});

test("Add time: a task has no time until the user gives it one; the block is pinned, clashes are refused, nothing else changes", async () => {
  const a = await mk({ title: "Report", plannedDate: DAY });
  const b = await mk({ title: "Review", plannedDate: DAY });
  assert.equal((await state()).plan, null, "no time by default");
  assert.equal((await state()).tasks.find((t: any) => t.id === a.id).estimateMinutes, null);
  const ok = await api("POST", `/api/tasks/${a.id}/schedule`, { date: DAY, start: "14:00", minutes: 60 });
  assert.equal(ok.status, 200);
  const plan = ok.json.state.plan;
  const blk = plan.blocks.find((x: any) => x.taskId === a.id);
  assert.deepEqual([blk.start, blk.end, blk.pinned], ["14:00", "15:00", true]);
  assert.equal(ok.json.state.tasks.find((t: any) => t.id === a.id).estimateMinutes, null, "no estimate was written");
  assert.ok(!blk.provisional, "a length the user chose is not a guess");
  assert.equal(ok.json.state.tasks.find((t: any) => t.id === b.id).plannedDate, DAY, "other tasks untouched");
  const clash = await api("POST", `/api/tasks/${b.id}/schedule`, { date: DAY, start: "14:30", minutes: 30 });
  assert.equal(clash.status, 409);
  assert.match(clash.json.error, /clashes/);
  assert.equal((await api("POST", `/api/tasks/${b.id}/schedule`, { date: DAY, start: "08:00", minutes: 30 })).status, 400, "already passed");
  assert.equal((await api("POST", `/api/tasks/${b.id}/schedule`, { date: "2026-10-30", start: "11:00", minutes: 30 })).status, 400, "today or tomorrow only");
  const second = await api("POST", `/api/tasks/${b.id}/schedule`, { date: DAY, start: "15:00", minutes: 45 });
  assert.equal(second.status, 200);
  assert.equal(second.json.state.plan.blocks.filter((x: any) => x.pinned).length, 2);
  assert.equal(second.json.state.plan.version, 2);
});
