import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import { z } from "zod";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { UserFacingError } from "../errors.js";
import { sendTest } from "../push.js";
import {
  disableTotp,
  finishTotpSetup,
  listSessions,
  recoveryCodesLeft,
  renameSession,
  requireRecentAuth,
  revokeOthers,
  revokeSession,
  sessionOf,
  startTotpSetup,
  totpEnabled,
} from "../security/auth.js";
import { secretsSummary } from "../security/secrets.js";
import { vaultStatus } from "../security/vault.js";
import { createAgent, deleteAgent, getAgent, listAgents, setAgentEnabled, updateAgent } from "../agents/profiles.js";
import { runAgent } from "../agents/engine.js";
import { listTools } from "../agents/tools.js";
import { listActivity, logActivity } from "./activity.js";
import { approveAction, cancelAction, editAction, executeAction, getAction, listActions, rejectAction, resolveUncertain } from "./actions.js";
import { backupPath, listBackups, makeBackup } from "./backup.js";
import { getBudget, saveBudget, spend } from "./budget.js";
import { controls, setControl, stopEverything } from "./controls.js";
import { listJobs, setJobEnabled } from "./jobs.js";
import { CATEGORIES, CATEGORY_LABEL, getPrefs, listNotifications, markRead, notify, savePrefs } from "./notifications.js";
import { getSpace, listAccounts, listSpaces, setSpaceEnabled } from "./spaces.js";

/**
 * Phase 0 routes (/api/system/*), all behind sign-in. System state always lives in the personal database, whichever
 * workspace (personal or demo) the page is showing.
 */
export const systemRouter = express.Router();
const db = () => getDb("personal");

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);
function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new UserFacingError("Invalid request.", 400, "invalid", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  return r.data;
}
const id = (req: Request) => String(req.params.id);

function overview(req: Request) {
  const d = db();
  const sess = sessionOf(req);
  const actions = listActions(d, { limit: 30 });
  return {
    security: {
      passwordSet: !!config.appPassword,
      vault: vaultStatus(),
      secrets: secretsSummary(d),
      twoFactor: totpEnabled(d),
      twoFactorForcedOff: process.env.NIKKI_DISABLE_2FA === "1",
      recoveryCodesLeft: recoveryCodesLeft(d),
      sessions: listSessions(d).map((s) => ({ ...s, current: s.id === sess?.id })),
      stepUpFresh: !config.appPassword || (!!sess?.verifiedAt && Date.now() - new Date(sess.verifiedAt).getTime() < 15 * 60_000),
    },
    controls: controls(d),
    spaces: listSpaces(d),
    accounts: listAccounts(d),
    budget: { settings: getBudget(d), spend: spend(d) },
    notifications: { unread: listNotifications(d, { limit: 1 }).unread, prefs: getPrefs(d), categories: CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABEL[c] })) },
    agents: listAgents(d).map((a) => ({ ...a, lastRun: d.prepare("SELECT id, status, started_at AS startedAt, summary, cost_usd AS costUsd FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1").get(a.id) ?? null })),
    tools: listTools(),
    jobs: listJobs(d),
    actions,
    pendingActions: actions.filter((a) => a.status === "pending" || a.status === "uncertain").length,
    backups: listBackups().slice(0, 5),
  };
}

systemRouter.get("/api/system/overview", h((req, res) => res.json(overview(req))));
systemRouter.get("/api/system/badge", h((_req, res) => res.json({ unread: listNotifications(db(), { limit: 1 }).unread, pending: listActions(db(), { status: ["pending", "uncertain"] }).length })));

// ---------- devices ----------

systemRouter.post("/api/system/sessions/:id/revoke", h((req, res) => {
  revokeSession(db(), id(req));
  res.json(overview(req));
}));
systemRouter.post("/api/system/sessions/revoke-others", h((req, res) => {
  revokeOthers(db(), sessionOf(req)?.id ?? null);
  res.json(overview(req));
}));
systemRouter.patch("/api/system/sessions/:id", h((req, res) => {
  renameSession(db(), id(req), parse(z.object({ label: z.string().max(60) }), req.body).label);
  res.json(overview(req));
}));

// ---------- two-step sign-in ----------

systemRouter.post("/api/system/2fa/setup", h((req, res) => {
  requireRecentAuth(req);
  res.json(startTotpSetup(db()));
}));
systemRouter.post("/api/system/2fa/enable", h((req, res) => {
  requireRecentAuth(req);
  const codes = finishTotpSetup(db(), parse(z.object({ code: z.string().max(12) }), req.body).code);
  res.json({ recoveryCodes: codes, overview: overview(req) });
}));
systemRouter.post("/api/system/2fa/disable", h((req, res) => {
  requireRecentAuth(req);
  disableTotp(db(), parse(z.object({ code: z.string().max(12).default("") }), req.body).code);
  res.json(overview(req));
}));

// ---------- notifications ----------

systemRouter.get("/api/system/notifications", h((req, res) => {
  const cat = typeof req.query.category === "string" && (CATEGORIES as readonly string[]).includes(req.query.category) ? (req.query.category as (typeof CATEGORIES)[number]) : undefined;
  res.json(listNotifications(db(), { unreadOnly: req.query.unread === "1", category: cat, limit: 100 }));
}));
systemRouter.post("/api/system/notifications/read", h((req, res) => {
  const b = parse(z.object({ ids: z.union([z.array(z.string()).max(200), z.literal("all")]), read: z.boolean().default(true) }), req.body);
  markRead(db(), b.ids, b.read);
  res.json(listNotifications(db(), { limit: 100 }));
}));
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
systemRouter.put("/api/system/notifications/prefs", h((req, res) => {
  const b = parse(
    z.object({
      push: z.record(z.enum(CATEGORIES), z.boolean()),
      quietHours: z.object({ enabled: z.boolean(), start: Time, end: Time }),
      showSensitivePreviews: z.boolean(),
    }),
    req.body,
  );
  savePrefs(db(), { ...getPrefs(db()), ...b, push: { ...getPrefs(db()).push, ...b.push } });
  res.json(overview(req));
}));
/** A test that goes through the whole notification path (history + push), urgent so quiet hours don't hold it. */
systemRouter.post("/api/system/notifications/test", h(async (req, res) => {
  const r = await notify(db(), { category: "system", priority: "urgent", title: "Test from Nikki", body: "If this reached your lock screen, notifications work on this device.", link: "/?view=inbox", kind: "test" });
  // Re-use the device verification of the existing test (it only counts once the device acknowledges it).
  if (r.pushed === 0) await sendTest(db()).catch(() => {});
  res.json({ pushed: r.pushed, item: r.item });
}));

// ---------- approvals and actions ----------

systemRouter.get("/api/system/actions", h((_req, res) => res.json({ actions: listActions(db(), { limit: 100 }) })));
systemRouter.patch("/api/system/actions/:id", h((req, res) => {
  const b = parse(z.object({ params: z.record(z.string(), z.unknown()), executeAfter: z.string().nullable().optional() }), req.body);
  res.json({ action: editAction(db(), id(req), b.params, b.executeAfter) });
}));
systemRouter.post("/api/system/actions/:id/approve", h(async (req, res) => {
  const a = getAction(db(), id(req));
  if (a?.level === "consequential") requireRecentAuth(req);
  const b = parse(z.object({ paramsHash: z.string().length(64) }), req.body);
  let action = approveAction(db(), id(req), b.paramsHash, sessionOf(req)?.id ?? null);
  if (action.status === "approved") action = await executeAction(db(), action.id);
  res.json({ action });
}));
systemRouter.post("/api/system/actions/:id/reject", h((req, res) => {
  rejectAction(db(), id(req));
  res.json({ action: getAction(db(), id(req)) });
}));
systemRouter.post("/api/system/actions/:id/cancel", h((req, res) => {
  cancelAction(db(), id(req));
  res.json({ action: getAction(db(), id(req)) });
}));
systemRouter.post("/api/system/actions/:id/resolve", h((req, res) => {
  resolveUncertain(db(), id(req), parse(z.object({ outcome: z.enum(["succeeded", "failed"]) }), req.body).outcome);
  res.json({ action: getAction(db(), id(req)) });
}));

// ---------- emergency controls, budget, spaces ----------

systemRouter.post("/api/system/controls", h((req, res) => {
  const b = parse(z.object({ control: z.enum(["agents", "actions", "ai"]), paused: z.boolean() }), req.body);
  setControl(db(), b.control, b.paused);
  res.json(overview(req));
}));
systemRouter.post("/api/system/stop-all", h((req, res) => {
  stopEverything(db());
  res.json(overview(req));
}));
systemRouter.put("/api/system/budget", h((req, res) => {
  const b = parse(
    z.object({ monthlyUsd: z.number().min(0).max(500), dailyUsd: z.number().min(0).max(500), blockPlannerAtLimit: z.boolean(), perAgentMonthlyUsd: z.record(z.string(), z.number().min(0).max(500)).default({}) }),
    req.body,
  );
  saveBudget(db(), b);
  res.json(overview(req));
}));
systemRouter.post("/api/system/spaces/:id", h((req, res) => {
  const b = parse(z.object({ enabled: z.boolean() }), req.body);
  if (b.enabled && getSpace(db(), id(req))?.confidential) requireRecentAuth(req);
  setSpaceEnabled(db(), id(req), b.enabled);
  res.json(overview(req));
}));

// ---------- activity ----------

systemRouter.get("/api/system/activity", h((req, res) => {
  const before = Number(req.query.before) || undefined;
  res.json({ entries: listActivity(db(), 100, before) });
}));

// ---------- agents ----------

systemRouter.post("/api/system/agents", h((req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(60), description: z.string().max(300).default(""), config: z.unknown() }), req.body);
  res.json({ agent: createAgent(db(), b, "user") });
}));
systemRouter.patch("/api/system/agents/:id", h((req, res) => {
  const b = parse(z.object({ name: z.string().max(60).optional(), description: z.string().max(300).optional(), config: z.unknown().optional() }), req.body);
  res.json({ agent: updateAgent(db(), id(req), b, "user") });
}));
systemRouter.post("/api/system/agents/:id/enable", h((req, res) => {
  setAgentEnabled(db(), id(req), parse(z.object({ enabled: z.boolean() }), req.body).enabled);
  res.json(overview(req));
}));
systemRouter.post("/api/system/agents/:id/run", h(async (req, res) => {
  if (!getAgent(db(), id(req))) throw new UserFacingError("That agent wasn't found.", 404, "not_found");
  res.json({ run: await runAgent(db(), id(req), "manual") });
}));
systemRouter.get("/api/system/agents/:id/runs", h((req, res) => {
  res.json({ runs: db().prepare("SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 20").all(id(req)) });
}));
systemRouter.delete("/api/system/agents/:id", h((req, res) => {
  deleteAgent(db(), id(req));
  res.json(overview(req));
}));

// ---------- jobs and backups ----------

systemRouter.post("/api/system/jobs/:id/enable", h((req, res) => {
  setJobEnabled(db(), id(req), parse(z.object({ enabled: z.boolean() }), req.body).enabled);
  res.json(overview(req));
}));
systemRouter.post("/api/system/backups/run", h(async (req, res) => {
  const b = await makeBackup(db());
  if (!b) throw new UserFacingError("Backups need the server encryption key (NIKKI_ENCRYPTION_KEY) first.", 409, "no_encryption_key");
  res.json(overview(req));
}));
systemRouter.post("/api/system/backups/:file/prepare", h((req, res) => {
  requireRecentAuth(req);
  if (!backupPath(String(req.params.file))) throw new UserFacingError("That backup wasn't found.", 404, "not_found");
  res.json({ ok: true });
}));
/** Encrypted file only: useless without the server key. Needs a fresh password check. */
systemRouter.get("/api/system/backups/:file", h((req, res) => {
  requireRecentAuth(req);
  const p = backupPath(String(req.params.file));
  if (!p) throw new UserFacingError("That backup wasn't found.", 404, "not_found");
  logActivity(db(), "user", "backup.downloaded", String(req.params.file), { session: sessionOf(req)?.id ?? null });
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${String(req.params.file)}"`);
  fs.createReadStream(p).pipe(res);
}));
