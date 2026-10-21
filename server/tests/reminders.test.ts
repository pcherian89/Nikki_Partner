import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-rem-"));
process.env.DATABASE_PATH = path.join(tmp, "nikki.db");
process.env.ANTHROPIC_API_KEY = "";
process.env.NIKKI_FAKE_NOW = "2026-10-21T08:00:00Z"; // 09:00 in London (BST)

const { app } = await import("../index.js");
const { setProvider } = await import("../provider/index.js");
const { getDb, wipe, closeAll } = await import("../db.js");
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
beforeEach(() => {
  wipe(getDb("personal"));
  setProvider(null);
  setPushSender(null);
  at("2026-10-21T08:00:00Z");
});

async function api(method: string, url: string, body?: unknown, client = "dev-a") {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json", "x-workspace": "personal", "x-timezone": TZ, "x-client-id": client },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
const state = async () => (await api("GET", "/api/state")).json.state;
const db = () => getDb("personal");
const blank = { questions: [], quick_replies: [], captured_items: [], task_updates: [], actions: [], meetings: [], context_updates: [], plan: null };
const fakeReply = (over: Record<string, unknown>) => setProvider({ name: "fake", model: "fake", generate: async () => ({ model: "fake", text: JSON.stringify({ ...blank, message: "ok", ...over }) }) });
const chat = (text: string) => api("POST", "/api/messages", { text, kind: "chat", clientRequestId: `req-${++rid}-xxxxxxxx` });
const act = (type: string, over: Record<string, unknown> = {}) => ({ type, task_id: "", minutes: 0, from: "", to: "", date: "", time: "", priority: "", flag: false, ...over });

test("a reminder is stored in the user's timezone and is not a task, block or meeting", async () => {
  const r = await api("POST", "/api/reminders", { title: "Follow up on the proposal", date: "2026-10-22", time: "09:00" });
  assert.equal(r.status, 200);
  assert.equal(r.json.reminder.remindAt, "2026-10-22T08:00:00.000Z", "09:00 London in October is 08:00 UTC");
  assert.equal(r.json.reminder.localTime, "09:00");
  const s = r.json.state;
  assert.equal(s.reminders.length, 1);
  assert.equal(s.tasks.length, 0);
  assert.equal(s.meetings.length, 0);
  assert.equal(s.plan, null);
  // winter time: same wall-clock time, different instant
  const w = await api("POST", "/api/reminders", { title: "After the clocks change", date: "2026-11-02", time: "09:00" });
  assert.equal(w.json.reminder.remindAt, "2026-11-02T09:00:00.000Z");
});

test("reminders in the past are refused; the same reminder is never created twice", async () => {
  assert.equal((await api("POST", "/api/reminders", { title: "Too late", date: "2026-10-21", time: "08:00" })).status, 400);
  const a = await api("POST", "/api/reminders", { title: "Call Sam", date: "2026-10-22", time: "10:00" });
  const b = await api("POST", "/api/reminders", { title: "call sam", date: "2026-10-22", time: "10:00" });
  assert.equal(b.json.created, false);
  assert.equal(b.json.reminder.id, a.json.reminder.id);
  assert.equal((await state()).reminders.length, 1);
});

test("a reminder fires when its time comes, exactly once, even if two ticks run together", async () => {
  await api("POST", "/api/reminders", { title: "Call Sam", date: "2026-10-21", time: "10:00" });
  const calls: string[] = [];
  const deliver = async (r: any) => (calls.push(r.id), ["push"]);
  assert.equal((await tickReminders(db(), TZ, deliver)).length, 0, "not yet");
  at("2026-10-21T09:00:30Z"); // 10:00:30 London
  const [a, b] = await Promise.all([tickReminders(db(), TZ, deliver), tickReminders(db(), TZ, deliver)]);
  assert.equal(a.length + b.length, 1, "one winner");
  assert.equal(calls.length, 1, "delivered once");
  assert.equal((await tickReminders(db(), TZ, deliver)).length, 0, "not again");
  const s = await state();
  assert.equal(s.reminders[0].status, "due");
  assert.deepEqual(s.reminders[0].channels, ["in-app", "push"]);
});

test("a reminder that came due while the app was closed is still there, and survives a restart", async () => {
  await api("POST", "/api/reminders", { title: "Send invoice", date: "2026-10-21", time: "10:00" });
  at("2026-10-22T07:00:00Z");
  await tickReminders(db(), TZ); // the server ticked while nobody was looking
  closeAll();
  const s = await state();
  assert.equal(s.reminders[0].status, "due");
  assert.deepEqual(s.reminders[0].channels, ["in-app"], "no push was claimed");
});

test("edit, snooze, complete and cancel", async () => {
  const r = (await api("POST", "/api/reminders", { title: "Call Sam", date: "2026-10-22", time: "10:00" })).json.reminder;
  const e = await api("PATCH", `/api/reminders/${r.id}`, { title: "Call Sam about the quote", date: "2026-10-23", time: "11:30" });
  assert.equal(e.json.reminder.title, "Call Sam about the quote");
  assert.equal(e.json.reminder.localDate, "2026-10-23");
  at("2026-10-23T10:31:00Z");
  await tickReminders(db(), TZ);
  const sn = await api("POST", `/api/reminders/${r.id}/snooze`, { minutes: 60 });
  assert.equal(sn.json.state.reminders[0].status, "pending");
  assert.equal(sn.json.state.reminders[0].remindAt, "2026-10-23T11:31:00.000Z");
  assert.equal((await api("POST", `/api/reminders/${r.id}/done`)).json.state.reminders.length, 0);
  assert.equal((await api("POST", `/api/reminders/${r.id}/done`)).status, 404, "already finished");
  const r2 = (await api("POST", "/api/reminders", { title: "Other", date: "2026-10-24" })).json.reminder;
  assert.equal(r2.localTime, "09:00", "default time of day");
  assert.equal((await api("POST", `/api/reminders/${r2.id}/cancel`)).json.state.reminders.length, 0);
});

test("a reminder can count down from a task's deadline, follows it when it moves, and goes when the task is done", async () => {
  const t = (await api("POST", "/api/tasks", { title: "Submit the tender", deadline: "2026-10-30", deadlineTime: "17:00" })).json.task;
  const r = await api("POST", "/api/reminders", { title: "Tender due soon", taskId: t.id, fromDeadline: { offsetDays: 2 } });
  assert.equal(r.json.reminder.localDate, "2026-10-28");
  assert.equal(r.json.reminder.localTime, "09:00");
  await api("PATCH", `/api/tasks/${t.id}`, { deadline: "2026-11-05" });
  assert.equal((await state()).reminders[0].localDate, "2026-11-03", "followed the deadline");
  await api("PATCH", `/api/tasks/${t.id}`, { status: "done" });
  assert.equal((await state()).reminders.length, 0);
  const none = (await api("POST", "/api/tasks", { title: "No deadline" })).json.task;
  assert.equal((await api("POST", "/api/reminders", { title: "x", taskId: none.id, fromDeadline: { offsetDays: 1 } })).status, 400);
});

test("deleting a task cancels the reminders linked to it", async () => {
  const t = (await api("POST", "/api/tasks", { title: "Prepare slides" })).json.task;
  await api("POST", "/api/reminders", { title: "Slides", taskId: t.id, date: "2026-10-22", time: "09:00" });
  await api("DELETE", `/api/tasks/${t.id}`);
  assert.equal((await state()).reminders.length, 0);
});

test("chat: 'remind me tomorrow morning' creates it with a receipt and Undo; the past is refused", async () => {
  fakeReply({ actions: [act("create_reminder", { title: "Follow up on the proposal", date: "2026-10-22", time: "09:00" })] });
  const r = await chat("Remind me tomorrow morning to follow up on the proposal");
  const rec = r.json.state.messages.at(-1).meta.receipts[0];
  assert.equal(rec.ok, true);
  assert.match(rec.text, /tomorrow at 9:00 AM/);
  assert.equal(r.json.state.reminders.length, 1);
  assert.equal(r.json.state.tasks.length, 0, "no task created");
  const u = await api("POST", `/api/undo/${rec.undoId}`);
  assert.equal(u.json.state.reminders.length, 0);
  fakeReply({ actions: [act("create_reminder", { title: "Yesterday", date: "2026-10-20", time: "09:00" })] });
  const bad = (await chat("remind me yesterday")).json.state.messages.at(-1).meta.receipts[0];
  assert.equal(bad.ok, false);
  fakeReply({ actions: [act("create_reminder", { title: "Vague" })] });
  assert.equal((await chat("remind me")).json.state.messages.at(-1).meta.receipts[0].ok, false, "no day given: asks instead of guessing");
});

test("chat: two days before a deadline, then snooze and complete by id", async () => {
  const t = (await api("POST", "/api/tasks", { title: "Launch", deadline: "2026-10-30" })).json.task;
  fakeReply({ actions: [act("create_reminder", { title: "Launch prep", task_id: t.id, from_deadline: true, offset_days: 2 })] });
  const s = (await chat("remind me two days before the launch deadline")).json.state;
  assert.equal(s.reminders[0].localDate, "2026-10-28");
  const id = s.reminders[0].id;
  fakeReply({ actions: [act("snooze_reminder", { reminder_id: id, minutes: 1440 })] });
  assert.equal((await chat("snooze it a day")).json.state.reminders[0].localDate, "2026-10-22");
  fakeReply({ actions: [act("complete_reminder", { reminder_id: id })] });
  assert.equal((await chat("done")).json.state.reminders.length, 0);
});

test("push: not verified until a device acknowledges a test; dead subscriptions are removed; sends are recorded only if accepted", async () => {
  const sub = { endpoint: "https://push.example.test/abc", keys: { p256dh: "BPk", auth: "au" } };
  assert.equal((await state()).notifications.subscriptions, 0);
  assert.equal((await api("POST", "/api/push/test")).status, 409, "nothing to send to yet");
  await api("POST", "/api/push/subscribe", sub);
  let s = (await state()).notifications;
  assert.equal(s.subscriptions, 1);
  assert.equal(s.thisDevice, true);
  assert.equal(s.verified, false);
  const sent: any[] = [];
  setPushSender(async (sb, payload) => (sent.push({ sb, payload: JSON.parse(payload) }), { statusCode: 201 }));
  at("2026-10-21T08:05:00Z");
  assert.equal((await api("POST", "/api/push/test")).json.sent, 1);
  assert.equal(sent[0].payload.kind, "test");
  assert.equal((await state()).notifications.verified, false, "sending is not proof");
  at("2026-10-21T08:05:05Z");
  await api("POST", "/api/push/ack");
  assert.equal((await state()).notifications.verified, true, "only the device's own acknowledgement verifies delivery");
  // a reminder push
  await api("POST", "/api/reminders", { title: "Call Sam", date: "2026-10-21", time: "10:00" });
  at("2026-10-21T09:00:30Z");
  const fired = await tickReminders(db(), TZ, deliverByPush(db()));
  assert.deepEqual(fired[0].channels, ["in-app", "push"]);
  assert.equal(sent.at(-1).payload.body, "Call Sam");
  // gone subscription
  setPushSender(async () => {
    throw Object.assign(new Error("gone"), { statusCode: 410 });
  });
  await api("POST", "/api/reminders", { title: "Another", date: "2026-10-21", time: "10:30" });
  at("2026-10-21T09:31:00Z");
  const f2 = await tickReminders(db(), TZ, deliverByPush(db()));
  assert.deepEqual(f2[0].channels, ["in-app"], "no push claimed when the service refused it");
  assert.equal((await state()).notifications.subscriptions, 0, "dead subscription removed");
});

test("push keys never appear in an export", async () => {
  await api("GET", "/api/push/key");
  const ex = await fetch(base + "/api/export", { headers: { "x-workspace": "personal" } });
  assert.equal(ex.status, 200);
  const text = await ex.text();
  assert.ok(!/vapid_private/.test(text));
  assert.ok(!/push_subscriptions/.test(text));
});
