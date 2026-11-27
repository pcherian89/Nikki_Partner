import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Phase 0 foundations without a password (local mode): vault, secrets, approvals, jobs, budget, notifications,
// agents, spaces, backups and outbound-URL checks.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-p0sys-"));
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

// ---------- vault and secrets ----------

test("vault: values open only with the right key and the right place; rotation works", () => {
  const s = vault.seal("hello", "secret:a");
  assert.ok(vault.isSealed(s));
  assert.equal(vault.open(s, "secret:a"), "hello");
  assert.throws(() => vault.open(s, "secret:b"), /integrity/, "bound to where it is stored");
  const tampered = s.slice(0, -2) + (s.endsWith("A") ? "B" : "A");
  assert.throws(() => vault.open(tampered, "secret:a"));
  const next = randomBytes(32).toString("base64");
  process.env.NIKKI_ENCRYPTION_KEY = next;
  process.env.NIKKI_ENCRYPTION_KEY_PREVIOUS = KEY;
  assert.equal(vault.open(s, "secret:a"), "hello", "old values open during rotation");
  assert.ok(vault.needsRewrap(s));
  delete process.env.NIKKI_ENCRYPTION_KEY_PREVIOUS;
  assert.throws(() => vault.open(s, "secret:a"), /not configured/);
  process.env.NIKKI_ENCRYPTION_KEY = "too-short";
  assert.equal(vault.vaultStatus().ready, false);
  assert.ok(vault.vaultStatus().problem);
});

test("the push signing key is sealed at rest and still works; plain values are sealed on start", () => {
  db().prepare("DELETE FROM secrets").run();
  db().prepare("INSERT INTO secrets (key, value) VALUES ('legacy', 'plain-text')").run();
  const pub = vapidPublicKey(db());
  const rows = db().prepare("SELECT key, value FROM secrets").all() as { key: string; value: string }[];
  assert.ok(rows.find((r) => r.key === "vapid_private")!.value.startsWith("enc:v1:"));
  assert.equal(vapidPublicKey(db()), pub, "same key read back");
  assert.deepEqual(protectStoredSecrets(db()), { sealed: 1, rewrapped: 0 });
  assert.equal(getSecret(db(), "legacy"), "plain-text");
});

test("account tokens are refused without an encryption key, sealed with one, and deleted on disconnect", () => {
  const acc = addAccount(db(), { provider: "google_personal", label: "Personal Gmail", spaceId: "personal" });
  process.env.NIKKI_ENCRYPTION_KEY = "";
  assert.throws(() => storeAccountCredential(db(), acc.id, "tok", ["gmail.readonly"]), /encryption key/);
  process.env.NIKKI_ENCRYPTION_KEY = KEY;
  storeAccountCredential(db(), acc.id, "tok-123", ["gmail.readonly"]);
  const raw = (db().prepare("SELECT value FROM secrets WHERE key = ?").get(`account:${acc.id}`) as { value: string }).value;
  assert.ok(raw.startsWith("enc:v1:") && !raw.includes("tok-123"));
  disconnectAccount(db(), acc.id);
  assert.equal(db().prepare("SELECT 1 FROM secrets WHERE key = ?").get(`account:${acc.id}`), undefined);
  assert.throws(() => addAccount(db(), { provider: "google_workspace", label: "Gov", spaceId: "government" }), /switched off|authorisation/);
});

// ---------- approvals ----------

test("an approval covers exactly what was shown; an edit clears it; it runs once", async () => {
  const a = actions.proposeAction(db(), { kind: "nikki.create_task", title: "Add task", spaceId: "personal", params: { title: "Draft the Avagama brochure" }, idempotencyKey: "k1" });
  assert.equal(actions.proposeAction(db(), { kind: "nikki.create_task", title: "Add task", spaceId: "personal", params: { title: "different" }, idempotencyKey: "k1" }).id, a.id, "same key, same action");
  await assert.rejects(actions.executeAction(db(), a.id), /won't run/, "not approved yet");
  const stale = a.paramsHash;
  actions.editAction(db(), a.id, { title: "Draft the Avagama brochure v2" });
  assert.throws(() => actions.approveAction(db(), a.id, stale, null), /changed after you looked/);
  const fresh = actions.getAction(db(), a.id)!;
  actions.approveAction(db(), a.id, fresh.paramsHash, null);
  // Tamper with stored params after approval: execution refuses.
  db().prepare("UPDATE actions SET params = ? WHERE id = ?").run(JSON.stringify({ title: "Something else" }), a.id);
  await assert.rejects(actions.executeAction(db(), a.id), /doesn't match/);
  db().prepare("UPDATE actions SET params = ? WHERE id = ?").run(JSON.stringify({ title: "Draft the Avagama brochure v2" }), a.id);
  const done = await actions.executeAction(db(), a.id);
  assert.equal(done.status, "succeeded");
  assert.ok(listTasks(db()).some((t) => t.title === "Draft the Avagama brochure v2"));
  await assert.rejects(actions.executeAction(db(), a.id), /won't run/, "never runs twice");
});

test("approval expires: a scheduled consequential action asks again when its time comes", async () => {
  const sent: string[] = [];
  actions.registerActionHandler({ kind: "test.send", label: "Test send", level: "consequential", external: true, schema: z.object({ to: z.string() }).strict(), execute: (_db, p) => (sent.push(p.to), { ok: true }) });
  const a = actions.proposeAction(db(), { kind: "test.send", title: "Send", spaceId: "revivo", params: { to: "x" }, executeAfter: "2026-11-28T03:30:00Z" });
  actions.approveAction(db(), a.id, a.paramsHash, null);
  assert.equal(actions.getAction(db(), a.id)!.status, "scheduled");
  at("2026-11-28T03:31:00Z"); // next day: the one-hour approval has lapsed
  await actions.runScheduledActions(db());
  assert.equal(actions.getAction(db(), a.id)!.status, "pending", "back to the user");
  assert.equal(sent.length, 0, "nothing sent");
  assert.ok(notif.listNotifications(db()).items.some((n) => n.title === "Please confirm again"));
});

test("an external action with an unknown outcome is 'uncertain' and is never retried", async () => {
  let calls = 0;
  actions.registerActionHandler({
    kind: "test.flaky",
    label: "Flaky",
    level: "consequential",
    external: true,
    schema: z.object({}).strict(),
    execute: () => {
      calls++;
      throw new Error("socket hang up");
    },
  });
  const a = actions.proposeAction(db(), { kind: "test.flaky", title: "Flaky", spaceId: "revivo", params: {} });
  actions.approveAction(db(), a.id, a.paramsHash, null);
  const r = await actions.executeAction(db(), a.id);
  assert.equal(r.status, "uncertain");
  await assert.rejects(actions.executeAction(db(), a.id));
  await actions.runScheduledActions(db());
  assert.equal(calls, 1, "called once only");
  actions.resolveUncertain(db(), a.id, "failed");
  assert.equal(actions.getAction(db(), a.id)!.status, "failed");
  // An action interrupted mid-run (process stopped) becomes uncertain on start.
  const b = actions.proposeAction(db(), { kind: "test.flaky", title: "Flaky 2", spaceId: "revivo", params: {} });
  db().prepare("UPDATE actions SET status = 'executing' WHERE id = ?").run(b.id);
  await actions.recoverActions(db());
  assert.equal(actions.getAction(db(), b.id)!.status, "uncertain");
});

test("emergency stop blocks execution; a disabled space blocks proposals; prohibited never runs", async () => {
  const a = actions.proposeAction(db(), { kind: "nikki.notify", title: "Ping", spaceId: "personal", params: { title: "hi", body: "" } });
  actions.approveAction(db(), a.id, a.paramsHash, null);
  setControl(db(), "actions", true);
  await assert.rejects(actions.executeAction(db(), a.id), /paused/);
  setControl(db(), "actions", false);
  assert.equal((await actions.executeAction(db(), a.id)).status, "succeeded");
  assert.throws(() => actions.proposeAction(db(), { kind: "nikki.notify", title: "x", spaceId: "government", params: { title: "x", body: "" } }), /switched off/);
  actions.registerActionHandler({ kind: "test.forbidden", label: "No", level: "prohibited", external: true, schema: z.object({}), execute: () => ({}) });
  assert.throws(() => actions.proposeAction(db(), { kind: "test.forbidden", title: "x", spaceId: "personal", params: {} }), /not allowed/);
});

test("approving over HTTP runs the action and records it in the activity log (ids, not content)", async () => {
  const a = actions.proposeAction(db(), { kind: "nikki.create_task", title: "Add", spaceId: "personal", params: { title: "Private: call the bank about the loan" } });
  const r = await api("POST", `/api/system/actions/${a.id}/approve`, { paramsHash: a.paramsHash });
  assert.equal(r.status, 200);
  assert.equal(r.json.action.status, "succeeded");
  const log = JSON.stringify(listActivity(db(), 50));
  assert.ok(log.includes(a.id));
  assert.ok(!log.includes("bank about the loan"), "no private content in the log");
  assert.throws(() => db().prepare("DELETE FROM activity_log").run(), /append-only/);
});

// ---------- jobs ----------

test("jobs: daily schedule in India time, lease prevents double runs, retries with back-off, missed slots", async () => {
  const runs: string[] = [];
  jobs.registerJobHandler("test.ok", (_db, j) => void runs.push(j.id));
  let fails = 0;
  jobs.registerJobHandler("test.fail", () => {
    fails++;
    throw new Error("boom");
  });
  at("2026-11-27T01:00:00Z"); // 06:30 IST
  const j = jobs.upsertJob(db(), { id: "t_daily", kind: "test.ok", name: "Daily", schedule: { type: "daily", time: "07:00" } });
  assert.equal(j.nextRunAt, "2026-11-27T01:30:00.000Z", "07:00 IST is 01:30 UTC");
  at("2026-11-27T01:31:00Z");
  // A lease held by another process blocks this one.
  db().prepare("UPDATE jobs SET lease_owner = 'other', lease_until = ? WHERE id = 't_daily'").run("2026-11-27T01:40:00Z");
  assert.deepEqual((await jobs.runDueJobs(db())).filter((x) => x === "t_daily"), []);
  db().prepare("UPDATE jobs SET lease_owner = NULL, lease_until = NULL WHERE id = 't_daily'").run();
  await jobs.runDueJobs(db());
  assert.equal(runs.filter((x) => x === "t_daily").length, 1);
  assert.equal(jobs.getJob(db(), "t_daily")!.nextRunAt, "2026-11-28T01:30:00.000Z");
  await jobs.runDueJobs(db());
  assert.equal(runs.filter((x) => x === "t_daily").length, 1, "not run twice");

  jobs.upsertJob(db(), { id: "t_fail", kind: "test.fail", name: "Fails", schedule: { type: "interval", minutes: 60 }, maxAttempts: 2 });
  at("2026-11-27T02:32:00Z");
  await jobs.runDueJobs(db());
  const f = jobs.getJob(db(), "t_fail")!;
  assert.equal(f.lastStatus, "retrying");
  assert.equal(f.nextRunAt, "2026-11-27T02:34:00.000Z", "back-off of 2 minutes after the first failure");
  at("2026-11-27T02:35:00Z");
  await jobs.runDueJobs(db());
  assert.equal(jobs.getJob(db(), "t_fail")!.lastStatus, "failed");
  assert.equal(fails, 2);
  jobs.setJobEnabled(db(), "t_fail", false);

  // Skip-late job after downtime: not run, moved on.
  jobs.upsertJob(db(), { id: "t_skip", kind: "test.ok", name: "Skip", schedule: { type: "interval", minutes: 10 }, catchUp: "skip" });
  at("2026-11-27T05:00:00Z");
  await jobs.runDueJobs(db());
  assert.equal(jobs.getJob(db(), "t_skip")!.lastStatus, "skipped_late");
  jobs.setJobEnabled(db(), "t_skip", false);
  jobs.setJobEnabled(db(), "t_daily", false);
});

// ---------- budget ----------

test("AI usage is metered from the API's token counts without changing the planner's model", async () => {
  setProvider({ name: "fake", model: "claude-opus-5-5", generate: async () => ({ model: "claude-opus-5-5", text: "{}", usage: { inputTokens: 283_313, outputTokens: 18_957 } }) });
  const p = getProvider()!;
  assert.equal(p.model, "claude-opus-5-5");
  await p.generate({ system: "s", messages: [{ role: "user", content: "x" }], schema: {} });
  const s = budget.spend(db());
  // 283,313 × $4/M + 18,957 × $20/M = $1.512
  assert.equal(Math.round(s.monthUsd * 1000), 1512);
  assert.equal(s.byWorkflow[0].workflow, "planner");
  assert.ok(s.percent > 30 && s.percent < 31);
});

test("budget alerts at 50/75/90/100% once each; agents hard-stop at the limit; planner keeps working by default", async () => {
  await budget.recordUsage(db(), { workflow: "planner", model: "claude-opus-5-5", usage: { inputTokens: 700_000, outputTokens: 0 }, status: "ok" }); // $2.80 = 56%
  await budget.recordUsage(db(), { workflow: "planner", model: "claude-opus-5-5", usage: { inputTokens: 0, outputTokens: 10_000 }, status: "ok" }); // +$0.20
  let titles = notif.listNotifications(db()).items.map((n) => n.title);
  assert.deepEqual(titles, ["AI budget 50% used"], "one alert, not repeated");
  await budget.recordUsage(db(), { workflow: "planner", model: "claude-opus-5-5", usage: { inputTokens: 0, outputTokens: 110_000 }, status: "ok" }); // +$2.20 → $5.20
  titles = notif.listNotifications(db()).items.map((n) => n.title);
  assert.ok(titles.includes("AI budget used up") && titles.includes("AI budget 90% used") && titles.includes("AI budget 75% used"));
  assert.throws(() => budget.reserve(db(), "agent:x", "x", 0.01), /budget/);
  budget.checkPlannerAllowed(db()); // does not throw by default
  budget.saveBudget(db(), { ...budget.getBudget(db()), blockPlannerAtLimit: true });
  assert.throws(() => budget.checkPlannerAllowed(db()), /used up/);
});

test("daily limit and reservations are enforced together; unknown models are priced high", () => {
  budget.saveBudget(db(), { monthlyUsd: 5, dailyUsd: 0.1, perAgentMonthlyUsd: {}, blockPlannerAtLimit: false });
  const r1 = budget.reserve(db(), "agent:a", "a", 0.06);
  assert.throws(() => budget.reserve(db(), "agent:b", "b", 0.06), /Today's AI limit/, "held money counts");
  budget.releaseReservation(db(), r1);
  budget.reserve(db(), "agent:b", "b", 0.06);
  assert.ok(budget.costOf("some-new-model", { inputTokens: 1_000_000, outputTokens: 0 }) >= 10);
});

test("an exhausted API credit pauses agent AI and tells the user once", async () => {
  await budget.onCreditExhausted(db());
  await budget.onCreditExhausted(db());
  assert.equal(budget.spend(db()).aiPaused, true);
  assert.equal(notif.listNotifications(db()).items.filter((n) => n.title.includes("credit")).length, 1);
  assert.throws(() => budget.reserve(db(), "agent:a", "a", 0.001), /credit/);
});

// ---------- notifications ----------

test("notifications: history, unread, quiet hours hold pushes, urgent breaks through, sensitive previews hidden", async () => {
  await api("POST", "/api/push/subscribe", { endpoint: "https://push.example.test/n", keys: { p256dh: "k", auth: "a" } });
  const sent: any[] = [];
  setPushSender(async (_s, payload) => (sent.push(JSON.parse(payload)), { statusCode: 201 }));
  setSetting(db(), "last_timezone", "Asia/Kolkata");
  const n1 = await notif.notify(db(), { category: "approval", title: "Approve the email to Ravi", body: "Re: invoice 42", sensitive: true, link: "/?view=inbox" });
  assert.equal(n1.item.pushStatus, "sent");
  assert.equal(sent[0].title, "Nikki", "sensitive title hidden on the lock screen");
  assert.ok(!JSON.stringify(sent[0]).includes("Ravi"));
  assert.equal(sent[0].url, "/?view=inbox");
  assert.equal(sent[0].badge, 1);
  at("2026-11-27T17:00:00Z"); // 22:30 IST
  const n2 = await notif.notify(db(), { category: "approval", title: "Later", body: "" });
  assert.equal(n2.item.pushStatus, "held");
  const n3 = await notif.notify(db(), { category: "security", priority: "urgent", title: "Locked", body: "" });
  assert.equal(n3.item.pushStatus, "sent");
  assert.equal(notif.safeLink("https://evil.example"), null, "deep links stay inside Nikki");
  at("2026-11-28T02:00:00Z"); // 07:30 IST
  assert.equal(await notif.sendQuietDigest(db()), 1);
  assert.match(sent.at(-1).body, /1 update arrived during quiet hours/);
  const list = await api("GET", "/api/system/notifications");
  assert.equal(list.json.unread, 3);
  await api("POST", "/api/system/notifications/read", { ids: "all" });
  assert.equal((await api("GET", "/api/system/notifications")).json.unread, 0);
});

test("a due reminder goes into the notification centre and is pushed even in quiet hours", async () => {
  await api("POST", "/api/push/subscribe", { endpoint: "https://push.example.test/r", keys: { p256dh: "k", auth: "a" } });
  const sent: any[] = [];
  setPushSender(async (_s, payload) => (sent.push(JSON.parse(payload)), { statusCode: 201 }));
  const { deliverByPush } = await import("../push.js");
  at("2026-11-27T17:30:00Z"); // 23:00 IST
  const ch = await deliverByPush(db())({ id: "rem_1", title: "Take medicine", remindAt: "2026-11-27T17:30:00.000Z" } as any);
  assert.deepEqual(ch, ["push"]);
  assert.equal(sent[0].kind, "reminder");
  assert.equal(sent[0].body, "Take medicine");
  assert.ok(notif.listNotifications(db()).items.some((n) => n.category === "reminder"));
});

test("Declarative Web Push fields are added only when the public address is known", () => {
  const prefs = notif.DEFAULT_PREFS;
  const plain = notif.pushPayload({ id: "n", category: "system", title: "T", body: "B", sensitive: false, link: "/?view=inbox" }, prefs, 2);
  assert.equal(plain.web_push, undefined);
  process.env.PUBLIC_URL = "https://nikki.example.app";
  const dec = notif.pushPayload({ id: "n", category: "system", title: "T", body: "B", sensitive: false, link: "/?view=inbox" }, prefs, 2) as any;
  delete process.env.PUBLIC_URL;
  assert.equal(dec.web_push, 8030);
  assert.equal(dec.notification.navigate, "https://nikki.example.app/?view=inbox");
  assert.equal(dec.app_badge, 2);
});

// ---------- agents ----------

test("agents: off by default, code-only runs cost nothing, emergency stop and space rules apply", async () => {
  const a = createAgent(db(), { name: "Count", config: { spaceId: "personal", collectors: ["open_tasks_summary"], notifyResult: false } });
  assert.equal(a.enabled, false);
  await assert.rejects(runAgent(db(), a.id, "schedule"), /switched off/);
  const r = await runAgent(db(), a.id, "manual");
  assert.equal(r.status, "succeeded");
  assert.equal(r.costUsd, 0);
  assert.match(r.summary, /open task/);
  setControl(db(), "agents", true);
  assert.equal((await runAgent(db(), a.id, "manual")).status, "stopped_paused");
  setControl(db(), "agents", false);
  assert.throws(() => createAgent(db(), { name: "Gov", config: { spaceId: "government", useAi: true } }), /switched off|confidential/);
  assert.throws(() => updateAgent(db(), a.id, { config: { ...a.config, maxLevel: "change", tools: ["nikki_propose_task"] } }, "ai"), /Only you/);
  assert.throws(() => createAgent(db(), { name: "Sneaky", config: { spaceId: "personal", tools: ["nikki_propose_task"], maxLevel: "read" } }), /needs the "change" level/);
});

test("agents with AI: tool calls go through the gateway, changes become proposals, spend is reserved and recorded", async () => {
  const a = createAgent(db(), {
    name: "Helper",
    config: { spaceId: "personal", useAi: true, modelTier: "fast", tools: ["nikki_list_open_tasks", "nikki_propose_task"], maxLevel: "change", notifyResult: false },
  });
  setAgentEnabled(db(), a.id, true);
  const turns: any[] = [];
  let n = 0;
  setAgentModel({
    turn: async (req) => {
      turns.push(JSON.parse(JSON.stringify(req.messages)));
      n++;
      const usage = { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 };
      if (n === 1)
        return {
          model: req.model,
          stopReason: "tool_use",
          usage,
          content: [
            { type: "tool_use", id: "t1", name: "nikki_list_open_tasks", input: {} },
            { type: "tool_use", id: "t2", name: "nikki_propose_task", input: { title: "Call the travel agent" } },
            { type: "tool_use", id: "t3", name: "nikki_notify_user", input: { title: "x", body: "y" } },
          ] as any,
        };
      return { model: req.model, stopReason: "end_turn", usage, content: [{ type: "text", text: "Proposed one task for your approval." }] as any };
    },
  });
  const r = await runAgent(db(), a.id, "manual");
  assert.equal(r.status, "succeeded");
  assert.equal(r.summary, "Proposed one task for your approval.");
  const results = turns[1].at(-1).content;
  assert.match(results[0].content, /^<untrusted_data source="nikki_list_open_tasks">/);
  assert.match(results[2].content, /Not allowed: not_allowed/, "tool outside the allow-list refused in code");
  const proposed = actions.listActions(db(), { status: ["pending"] });
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].agentId, a.id);
  assert.ok(!listTasks(db()).some((t) => t.title === "Call the travel agent"), "nothing created without approval");
  assert.ok(r.costUsd > 0);
  assert.equal(budget.spend(db()).byModel[0].model, "claude-haiku-5-5");
  // Over budget: the run stops before calling the model.
  budget.saveBudget(db(), { monthlyUsd: 0.0001, dailyUsd: 1, perAgentMonthlyUsd: {}, blockPlannerAtLimit: false });
  const before = n;
  assert.equal((await runAgent(db(), a.id, "manual")).status, "stopped_budget");
  assert.equal(n, before, "no model call when the budget can't cover it");
});

// ---------- backups and outbound URLs ----------

test("nightly backup is encrypted, opens with the key, and is skipped without a key", async () => {
  const b = await makeBackup(db());
  assert.ok(b);
  const file = path.join(path.dirname(process.env.DATABASE_PATH!), "backups", b!.file);
  const data = fs.readFileSync(file);
  assert.ok(data.subarray(0, 10).toString().startsWith("NIKKIENC1"));
  assert.ok(!data.includes(Buffer.from("SQLite format 3")), "not readable without the key");
  const plain = vault.openFile(data, AAD);
  assert.ok(plain.subarray(0, 15).toString() === "SQLite format 3");
  process.env.NIKKI_ENCRYPTION_KEY = "";
  assert.equal(await makeBackup(db()), null);
  assert.ok(listBackups().length >= 1);
});

test("outbound links can't reach private networks on a hosted server", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "172.20.0.1", "100.100.1.1", "::1", "fd12::1", "::ffff:127.0.0.1"]) assert.ok(isPrivateAddress(ip), ip);
  assert.ok(!isPrivateAddress("8.8.8.8"));
  await assert.rejects(assertPublicUrl("http://localhost:3001/x", false), /private network/);
  await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data", false), /private network/);
  await assert.rejects(assertPublicUrl("http://service.railway.internal/", false), /private network/);
  await assert.rejects(assertPublicUrl("https://user:pw@example.com/", false), /user name or password/);
});
