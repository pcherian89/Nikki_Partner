import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-strat-"));
process.env.DATABASE_PATH = path.join(tmp, "nikki.db");
process.env.ANTHROPIC_API_KEY = "";
process.env.NIKKI_FAKE_NOW = "2026-10-21T08:00:00Z";

const { app } = await import("../index.js");
const { setProvider } = await import("../provider/index.js");
const { getDb, wipe } = await import("../db.js");

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
  wipe(getDb("demo"));
  setProvider(null);
  at("2026-10-21T08:00:00Z");
});

async function api(method: string, url: string, body?: unknown, ws = "personal") {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json", "x-workspace": ws, "x-timezone": TZ, "x-client-id": "dev-a" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
const state = async (ws = "personal") => (await api("GET", "/api/state", undefined, ws)).json.state;
const blank = { questions: [], quick_replies: [], captured_items: [], task_updates: [], actions: [], meetings: [], context_updates: [], memory_updates: [], project_plan: null, plan: null };
let lastPrompt = "";
const fakeReply = (over: Record<string, unknown>) =>
  setProvider({
    name: "fake",
    model: "fake",
    generate: async (req: any) => ((lastPrompt = req.messages.at(-1).content), { model: "fake", text: JSON.stringify({ ...blank, message: "ok", ...over }) }),
  });
const chat = (text: string, kind = "chat", ws = "personal") => api("POST", "/api/messages", { text, kind, clientRequestId: `req-${++rid}-xxxxxxxx` }, ws);
const mu = (over: Record<string, unknown>) => ({ op: "add", item_id: "", kind: "decision", text: "", status: "tentative", rationale: "", project_id: "", review_after: "", reason: "", ...over });

test("the user can add, correct, re-label, outdate and remove what Nikki remembers; duplicates are never stored", async () => {
  const a = await api("POST", "/api/memory", { kind: "priority", text: "Consulting retainer comes first" });
  assert.equal(a.status, 200);
  let m = a.json.state.memory[0];
  assert.equal(m.status, "confirmed", "typed by the user: firm");
  assert.equal(m.source, "user");
  assert.equal((await api("POST", "/api/memory", { kind: "priority", text: "consulting retainer comes first" })).json.state.memory.length, 1);
  await api("PATCH", `/api/memory/${m.id}`, { text: "Client work comes first until March" });
  await api("PATCH", `/api/memory/${m.id}`, { status: "tentative" });
  m = (await state()).memory[0];
  assert.equal(m.text, "Client work comes first until March");
  assert.equal(m.status, "tentative");
  assert.ok(m.reviewAfter, "tentative things get a review date");
  await api("PATCH", `/api/memory/${m.id}`, { status: "outdated" });
  assert.equal((await state()).memory[0].status, "outdated");
  assert.equal((await api("DELETE", `/api/memory/${m.id}`)).json.state.memory.length, 0);
  assert.equal((await api("DELETE", `/api/memory/${m.id}`)).status, 404);
  assert.equal(((await state("demo")).memory as any[]).length, 0, "demo workspace is separate");
});

test("Nikki can only propose changes to memory; nothing is stored until the user confirms, and the user picks which", async () => {
  fakeReply({ memory_updates: [mu({ kind: "decision", text: "Pause the mobile app until the consulting contract renews", status: "approved", rationale: "Consulting pays the bills; the app has no deadline." }), mu({ kind: "idea", text: "Maybe offer workshops", status: "tentative" })] });
  const r = await chat("Yes, let's pause the mobile app for now.");
  assert.equal(r.json.state.memory.length, 0, "proposed only");
  const p = r.json.state.proposal;
  assert.equal(p.memoryUpdates.length, 2);
  const keep = p.memoryUpdates[0].id;
  assert.equal((await api("POST", `/api/proposals/${p.id}/confirm`, { acceptedMemoryIds: [keep] })).status, 200);
  const mem = (await state()).memory;
  assert.equal(mem.length, 1);
  assert.equal(mem[0].status, "approved");
  assert.match(mem[0].rationale, /pays the bills/);
  assert.equal(mem[0].source, "nikki");
});

test("a bad reference is caught by the app before the user sees it", async () => {
  fakeReply({ memory_updates: [mu({ op: "update", item_id: "mem_nope", text: "x" })] });
  const r = await chat("update my priorities");
  assert.equal(r.json.state.proposal?.memoryUpdates?.length ?? 0, 0);
});

test("discussing an idea creates nothing: no project, task, memory or proposal", async () => {
  fakeReply({ message: "That's worth thinking through. What would it displace?", questions: ["What would it displace?"] });
  const r = await chat("I'm considering starting another product.");
  const s = r.json.state;
  assert.equal(s.proposal, null);
  assert.equal(s.projects.length, 0);
  assert.equal(s.tasks.length, 0);
  assert.equal(s.memory.length, 0);
});

test("an approved decision becomes a project and a remembered decision in one confirmation", async () => {
  fakeReply({
    message: "Here's the plan if you go with it.",
    project_plan: { project_id: "", title: "Launch workshops", goal: "Run the first paid workshop.", target_date: "2026-12-15", assumptions: ["Two evenings a week"], dependencies: [], milestones: [{ id: "", ref: "m1", title: "Outline the workshop", target_date: "2026-11-10", remove: false }], tasks: [{ ref: "t1", title: "Draft the outline", milestone_ref: "m1", priority: "normal", estimate_minutes: 0 }], reason: "" },
    memory_updates: [mu({ kind: "decision", text: "Offer paid workshops instead of a second product this quarter", status: "approved", rationale: "Faster to revenue.", review_after: "2027-01-15" })],
  });
  const r = await chat("Yes, go with the workshops instead of the second product.");
  assert.equal(r.json.state.projects.length, 0);
  await api("POST", `/api/proposals/${r.json.state.proposal.id}/confirm`, {});
  const s = await state();
  assert.equal(s.projects.length, 1);
  assert.equal(s.memory[0].kind, "decision");
  assert.equal(s.memory[0].reviewAfter, "2027-01-15");
});

test("what goes to the model: firm items, related soft items; never outdated or stale ones; size stays bounded", async () => {
  await api("POST", "/api/memory", { kind: "focus", text: "Finishing the consulting deliverable" });
  await api("POST", "/api/memory", { kind: "constraint", text: "Only 20 hours a week available" });
  await api("POST", "/api/memory", { kind: "idea", text: "Maybe a newsletter about procurement", status: "tentative" });
  await api("POST", "/api/memory", { kind: "idea", text: "Maybe learn woodworking", status: "tentative" });
  const old = (await api("POST", "/api/memory", { kind: "priority", text: "Old priority about tenders", status: "confirmed" })).json.state.memory.at(-1);
  await api("PATCH", `/api/memory/${old.id}`, { status: "outdated" });
  fakeReply({});
  await chat("Should I start the procurement newsletter?");
  assert.match(lastPrompt, /Finishing the consulting deliverable/);
  assert.match(lastPrompt, /procurement/);
  assert.ok(!/woodworking/.test(lastPrompt), "unrelated tentative idea is not sent");
  assert.ok(!/Old priority about tenders/.test(lastPrompt), "outdated items are not used");
  for (let i = 0; i < 60; i++) await api("POST", "/api/memory", { kind: "commitment", text: `Commitment number ${i} with a long description about what is involved here` });
  fakeReply({});
  await chat("What should I prioritise?");
  const strategy = JSON.parse(lastPrompt.split("<app_state>")[1].split("</app_state>")[0]).app_facts.strategy;
  assert.ok(strategy.items.length <= 30, `bounded (${strategy.items.length})`);
  assert.ok(strategy.not_shown > 0);
});

test("tentative things expire for review: still visible to the user, no longer used; keeping renews them", async () => {
  const item = (await api("POST", "/api/memory", { kind: "idea", text: "Maybe a podcast", status: "tentative" })).json.state.memory[0];
  at("2026-12-01T08:00:00Z");
  let s = await state();
  assert.equal(s.memory[0].stale, true);
  fakeReply({});
  await chat("podcast?");
  assert.ok(!/Maybe a podcast/.test(lastPrompt));
  s = (await api("PATCH", `/api/memory/${item.id}`, { keep: true })).json.state;
  assert.equal(s.memory[0].stale, false);
});

test("the memory limit protects against unbounded storage", async () => {
  for (let i = 0; i < 80; i++) assert.equal((await api("POST", "/api/memory", { kind: "commitment", text: `Item ${i}` })).status, 200);
  assert.equal((await api("POST", "/api/memory", { kind: "commitment", text: "One more" })).status, 409);
});

test("weekly review: counts come from real records and unknowns are stated as limits", async () => {
  // a project with recorded work, a neglected project, a finished task with no recorded time
  const mkTask = async (b: Record<string, unknown>) => (await api("POST", "/api/tasks", b)).json.task;
  const mkProject = async (title: string) => {
    fakeReply({ project_plan: { project_id: "", title, goal: "g", target_date: "2027-01-01", assumptions: [], dependencies: [], milestones: [{ id: "", ref: "m1", title: "First", target_date: "2026-11-01", remove: false }], tasks: [{ ref: "t1", title: `${title} task`, milestone_ref: "m1", priority: "normal", estimate_minutes: 0 }], reason: "" } });
    const r = await chat(`plan ${title}`);
    await api("POST", `/api/proposals/${r.json.state.proposal.id}/confirm`, {});
  };
  await mkProject("Alpha");
  await mkProject("Beta");
  const s0 = await state();
  const alphaTask = s0.tasks.find((t: any) => t.title === "Alpha task");
  at("2026-10-19T09:00:00Z");
  await api("POST", `/api/tasks/${alphaTask.id}/timer`, { action: "start" });
  at("2026-10-19T10:30:00Z");
  await api("POST", `/api/tasks/${alphaTask.id}/finish`, {});
  const quick = await mkTask({ title: "Call the accountant" });
  at("2026-10-20T09:00:00Z");
  await api("PATCH", `/api/tasks/${quick.id}`, { status: "done" });
  const open = await mkTask({ title: "Prepare the board pack", plannedDate: "2026-10-20", deadline: "2026-10-23" });
  at("2026-10-21T08:00:00Z");
  fakeReply({ message: "Good week on Alpha; Beta got no time." });
  const r = await chat("Weekly review", "weekly_review");
  const w = r.json.state.messages.at(-1).meta.weekly;
  assert.equal(w.completed.length, 2);
  assert.equal(w.recordedMinutes, 90);
  assert.equal(w.completed.find((c: any) => c.title === "Alpha task").minutes, 90);
  assert.equal(w.completed.find((c: any) => c.title === "Call the accountant").minutes, 0);
  assert.deepEqual(w.limitedAttention, ["Beta"]);
  assert.ok(w.unfinished.some((t: any) => t.id === open.id));
  assert.ok(w.upcoming.deadlines.some((d: any) => d.title === "Prepare the board pack"));
  assert.ok(w.dataGaps.some((g: string) => /no recorded time/.test(g)), "a finished task without time is flagged as a limit");
  const alpha = w.projects.find((p: any) => p.title === "Alpha");
  assert.equal(alpha.minutesThisWeek, 90);
  assert.equal(alpha.tasksDoneThisWeek, 1);
  assert.match(lastPrompt, /"weekly"/, "the model receives the counts");
  assert.equal(r.json.state.proposal, null, "a review changes nothing");
  // ordinary chat does not carry the weekly numbers
  fakeReply({});
  await chat("hello");
  assert.ok(!/"weekly"/.test(lastPrompt));
});

test("weekly review in Demo mode is a plain factual summary with its limits, no model needed", async () => {
  const t = (await api("POST", "/api/tasks", { title: "Send invoices" }, "demo")).json.task;
  await api("PATCH", `/api/tasks/${t.id}`, { status: "done" }, "demo");
  const r = await chat("Weekly review", "weekly_review", "demo");
  const m = r.json.state.messages.at(-1);
  assert.match(m.text, /Done: 1 task/);
  assert.match(m.text, /Limits of this review/);
  assert.equal(m.meta.weekly.completed.length, 1);
});

test("private text does not appear in server logs", async () => {
  const secret = "my-private-negotiation-with-Acme-Corp";
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    fakeReply({ memory_updates: [mu({ kind: "constraint", text: secret, status: "confirmed" })] });
    await chat(`Remember this: ${secret}`);
    setProvider({ name: "fake", model: "fake", generate: async () => { throw new Error("boom"); } });
    await chat(`Another thing about ${secret}`);
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!logs.some((l) => l.includes(secret)), "no private text in logs");
});
