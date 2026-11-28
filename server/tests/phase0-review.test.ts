import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Phase 0 review refinements (local mode): inbox wording and "Later", stop/resume semantics, budget maths and scope.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-p0rev-"));
process.env.DATABASE_PATH = path.join(tmp, "nikki.db");
process.env.ANTHROPIC_API_KEY = "";
process.env.NIKKI_FAKE_NOW = "2026-11-27T06:30:00Z"; // 12:00 in India
const KEY = randomBytes(32).toString("base64");
process.env.NIKKI_ENCRYPTION_KEY = KEY;

const { app } = await import("../index.js");
const { getDb, setSetting, listTasks } = await import("../db.js");
const { setProvider, getProvider } = await import("../provider/index.js");
const { setPushSender, vapidPublicKey } = await import("../push.js");
const vault = await import("../security/vault.js");
const { protectStoredSecrets, getSecret } = await import("../security/secrets.js");
const actions = await import("../system/actions.js");
const jobs = await import("../system/jobs.js");
const budget = await import("../system/budget.js");
const notif = await import("../system/notifications.js");
const { setControl } = await import("../system/controls.js");
const { bootstrapSystem } = await import("../system/bootstrap.js");
const { listActivity } = await import("../system/activity.js");
const { createAgent, updateAgent, setAgentEnabled } = await import("../agents/profiles.js");
const { runAgent } = await import("../agents/engine.js");
const { setAgentModel } = await import("../agents/model.js");
const { makeBackup, listBackups, AAD } = await import("../system/backup.js");
const { isPrivateAddress, assertPublicUrl } = await import("../security/ssrf.js");
const { addAccount, storeAccountCredential, disconnectAccount } = await import("../system/spaces.js");

let server: Server;
let base = "";
const at = (iso: string) => (process.env.NIKKI_FAKE_NOW = iso);
const db = () => getDb("personal");
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  await bootstrapSystem(db());
});
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  at("2026-11-27T06:30:00Z");
  process.env.NIKKI_ENCRYPTION_KEY = KEY;
  delete process.env.NIKKI_ENCRYPTION_KEY_PREVIOUS;
  for (const t of ["actions", "ai_usage", "budget_reservations", "notifications", "agent_runs", "push_subscriptions"]) db().prepare(`DELETE FROM ${t}`).run();
  db().prepare("DELETE FROM settings WHERE key LIKE 'control_%' OR key IN ('ai_budget', 'notification_prefs')").run();
  setProvider(null);
  setAgentModel(null);
  setPushSender(null);
});

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", "x-workspace": "personal", "x-timezone": "Asia/Kolkata" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}


test("inbox items carry plain wording: what it is, the button, what happens, and who suggested it", async () => {
  const a = createAgent(db(), { name: "Morning helper", config: { spaceId: "personal", collectors: [], notifyResult: false } });
  actions.proposeAction(db(), { kind: "nikki.create_reminder", title: "Pay the electricity bill", reason: "The bill is due on Monday.", agentId: a.id, spaceId: "personal", params: { title: "Pay the electricity bill", date: "2026-11-28", time: "09:00" } }, `agent:${a.id}`);
  const r = await api("GET", "/api/system/actions");
  const item = r.json.actions[0];
  assert.equal(item.approveLabel, "Add reminder");
  assert.equal(item.noun, "Reminder");
  assert.match(item.consequence, /only reminds you: nothing is paid/);
  assert.equal(item.reason, "The bill is due on Monday.");
  assert.equal(item.agentName, "Morning helper");
  assert.equal(item.external, false);
});

test("editing an item changes what is approved: the old fingerprint no longer works", () => {
  const a = actions.proposeAction(db(), { kind: "nikki.create_task", title: "Book a table", spaceId: "personal", params: { title: "Book a table" } });
  const e = actions.editAction(db(), a.id, { title: "Book a table for four" });
  assert.notEqual(e.paramsHash, a.paramsHash);
  assert.throws(() => actions.approveAction(db(), a.id, a.paramsHash, null), /changed after you looked/);
  assert.equal(actions.approveAction(db(), a.id, e.paramsHash, null).status, "approved");
});

test("'Later' hides an item from the badge until its time, never past its expiry, and changes no approval", async () => {
  const a = actions.proposeAction(db(), { kind: "nikki.create_task", title: "Renew passport", spaceId: "personal", params: { title: "Renew passport" } });
  assert.equal(actions.waitingCount(db()), 1);
  assert.equal((await api("POST", `/api/system/actions/${a.id}/snooze`, { until: "2026-11-27T06:00:00Z" })).status, 400, "a past time is refused");
  const s = await api("POST", `/api/system/actions/${a.id}/snooze`, { until: "2026-11-27T09:30:00Z" });
  assert.equal(s.status, 200);
  assert.equal(s.json.action.status, "pending");
  assert.equal(actions.waitingCount(db()), 0);
  assert.equal((await api("GET", "/api/system/badge")).json.pending, 0);
  at("2026-11-27T09:31:00Z");
  assert.equal(actions.waitingCount(db()), 1, "back when the time comes");
  // A far-future "later" is capped an hour before the proposal expires.
  const b = actions.proposeAction(db(), { kind: "nikki.create_task", title: "Later far", spaceId: "personal", params: { title: "Later far" } });
  const capped = actions.snoozeAction(db(), b.id, "2027-01-01T00:00:00Z");
  assert.ok(new Date(capped.snoozedUntil!).getTime() < new Date(b.expiresAt).getTime());
});

test("while stopped, approving is refused; on resume, due approvals are asked again and nothing runs by itself", async () => {
  const due = actions.proposeAction(db(), { kind: "nikki.create_task", title: "Due now", spaceId: "personal", params: { title: "Due now" } });
  actions.approveAction(db(), due.id, due.paramsHash, null);
  const later = actions.proposeAction(db(), { kind: "nikki.create_task", title: "Tomorrow", spaceId: "personal", params: { title: "Tomorrow" }, executeAfter: "2026-11-28T03:30:00Z" });
  actions.approveAction(db(), later.id, later.paramsHash, null);
  const waiting = actions.proposeAction(db(), { kind: "nikki.create_task", title: "Waiting", spaceId: "personal", params: { title: "Waiting" } });
  assert.equal((await api("POST", "/api/system/stop-all", {})).status, 200);
  const r = await api("POST", `/api/system/actions/${waiting.id}/approve`, { paramsHash: waiting.paramsHash });
  assert.equal(r.status, 423, "no approving while stopped");
  await actions.runScheduledActions(db());
  assert.ok(!listTasks(db()).some((t) => t.title === "Due now"), "nothing runs while stopped");
  assert.equal((await api("POST", "/api/system/resume-all", {})).status, 200);
  const d = actions.getAction(db(), due.id)!;
  assert.equal(d.status, "pending", "asked again");
  assert.equal(d.approvedAt, null);
  assert.equal(actions.getAction(db(), later.id)!.status, "scheduled", "future items keep their time");
  assert.ok(!listTasks(db()).some((t) => t.title === "Due now"), "resume runs nothing");
  assert.ok(notif.listNotifications(db()).items.some((n) => n.title === "Please confirm again"));
  assert.ok(listActivity(db(), 50).some((x: any) => x.kind === "action.requeued_after_stop"));
});

test("the emergency stop takes effect inside a running agent, before its next step", async () => {
  const a = createAgent(db(), { name: "Busy", config: { spaceId: "personal", useAi: true, modelTier: "fast", tools: ["nikki_propose_task"], maxLevel: "change", notifyResult: false } });
  setAgentEnabled(db(), a.id, true);
  let calls = 0;
  setAgentModel({
    turn: async (req) => {
      calls++;
      setControl(db(), "agents", true); // the user presses Stop while this request is in flight
      return { model: req.model, stopReason: "tool_use", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, content: [{ type: "tool_use", id: "t1", name: "nikki_propose_task", input: { title: "Should not appear", reason: "x" } }] as any };
    },
  });
  const r = await runAgent(db(), a.id, "manual");
  assert.equal(r.status, "stopped_paused");
  assert.equal(calls, 1, "no further model call");
  assert.equal(r.toolCalls, 0, "the tool call after Stop never ran");
  assert.equal(actions.listActions(db(), { status: ["pending"] }).length, 0);
  assert.ok(r.costUsd > 0, "the in-flight request is still counted");
  assert.equal(budget.spend(db()).byModel.length, 1);
});

test("cost maths: uncached input, cache reads and cache writes are priced separately; Haiku over 100K uses the higher rate", () => {
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  // Opus 5.5: 100K uncached in, 10K out, 200K cache read, 20K cache write.
  near(budget.costOf("claude-opus-5-5", { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 200_000, cacheWriteTokens: 20_000 }), 0.4 + 0.2 + 0.04 + 0.1);
  near(budget.costOf("claude-opus-5-5-20261101", { inputTokens: 1_000_000, outputTokens: 0 }), 4);
  near(budget.costOf("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 12);
  near(budget.costOf("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 1_000 }), 0.01 + 0.0005);
  // Over 100K prompt tokens (cache counts included), the whole Haiku call is billed at $0.50 / $2.50.
  near(budget.costOf("claude-haiku-5-5", { inputTokens: 90_000, outputTokens: 1_000, cacheReadTokens: 20_000 }), 0.045 + 0.0025 + 0.001);
  // Unknown models err high.
  assert.ok(budget.costOf("some-new-model", { inputTokens: 1_000_000, outputTokens: 0 }) >= 10);
});

test("budget scope: $5 a month for all AI, $0.25 a day for agents; counting starts on first start and nothing is back-filled", () => {
  assert.equal(budget.DEFAULT_BUDGET.monthlyUsd, 5);
  assert.equal(budget.DEFAULT_BUDGET.dailyUsd, 0.25);
  assert.equal(budget.DEFAULT_BUDGET.blockPlannerAtLimit, false);
  const since = budget.meteringSince(db());
  assert.ok(since, "start date recorded");
  at("2026-12-15T00:00:00Z");
  assert.equal(budget.meteringSince(db()), since, "the start date never moves");
  const s = budget.spend(db());
  assert.equal(s.monthUsd, 0, "no historical or sample records");
  assert.equal(s.since, since);
  assert.equal(s.remainingUsd, 5);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM ai_usage").get() as any).n, 0);
});

test("only agents can put items in the inbox: chat requests are confirmed in chat, never approved twice", () => {
  // Code check: proposeAction is used by the agent tool gateway only, not by chat, commands or the planner.
  const dir = path.join(import.meta.dirname, "..");
  const users: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) f.name !== "tests" && walk(p);
      else if (p.endsWith(".ts") && fs.readFileSync(p, "utf8").includes("proposeAction(")) users.push(path.relative(dir, p));
    }
  };
  walk(dir);
  assert.deepEqual(users.sort(), ["agents/tools.ts", "system/actions.ts"]);
});

test("the test-notification button is gone from the server", async () => {
  const r = await api("POST", "/api/system/notifications/test", {});
  assert.equal(r.status, 404);
  assert.equal(notif.listNotifications(db()).items.length, 0);
});
