import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { getDb, getProfile, getSetting } from "../db.js";
import { UserFacingError } from "../errors.js";
import { rebuildPlanMeetings, resolveTimezone } from "../planOps.js";
import { addDays, localNow } from "../time.js";
import { getFeeds } from "../calendar.js";
import { requireRecentAuth, sessionOf } from "../security/auth.js";
import { listSpaces } from "../system/spaces.js";
import { logActivity } from "../system/activity.js";
import { disconnectGoogle, finishConnect, googleAccount, listGoogleAccounts, removeGoogleAccount, setAccountSpace, setCalendarSelection, startConnect } from "./accounts.js";
import { overlappingFeeds, syncGoogleCalendar } from "./calendarSync.js";
import { googleSetup } from "./config.js";
import { checkGmail, forgetGmailCache, getConversation, searchEmail } from "./gmail.js";
import { callsToday, GoogleError } from "./mcp.js";
import { confirmKeySaved, recoveryStatus, runRestoreCheck } from "./recovery.js";

/** Stage 1A routes. Everything under /api needs sign-in; only the Google callback (/oauth/google/callback) doesn't,
 *  and it is protected by a single-use, 10-minute state tied to the signed-in device that started it. */
export const googleRouter = express.Router();
const db = () => getDb("personal");
/** The user's time zone: profile, then the last device seen, then India time (the default for this assistant). */
const tz = () => {
  const d = db();
  return resolveTimezone(getProfile(d), getSetting(d, "last_timezone") || "Asia/Kolkata");
};
const rebuild = () => {
  const t = tz();
  const today = localNow(t).date;
  return (_dates: string[]) => [today, addDays(today, 1)].forEach((d) => rebuildPlanMeetings(db(), d, today));
};

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch((e) => next(e instanceof GoogleError ? new UserFacingError(e.message, e.status, `google_${e.code}`) : e));
function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new UserFacingError("Invalid request.", 400, "invalid", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  return r.data;
}
const personalOnly = (req: Request) => {
  if (req.header("x-workspace") === "demo") throw new UserFacingError("Email and Google Calendar aren't available in Demo mode.", 403, "demo");
};

function status() {
  const d = db();
  const setup = googleSetup();
  return {
    setup: { configured: setup.configured, redirectUri: setup.redirectUri, problems: setup.problems },
    recovery: recoveryStatus(d),
    accounts: listGoogleAccounts(d),
    spaces: listSpaces(d).filter((s) => s.enabled && !s.confidential).map((s) => ({ id: s.id, name: s.name })),
    callsToday: callsToday(d),
    overlappingFeeds: overlappingFeeds(d, getFeeds(d)),
    permissions: {
      can: ["Search and read your Gmail", "Read your Google Calendar events and calendars"],
      cannot: ["Send, reply or forward email", "Delete, archive, label, move or mark email as read", "Create, change or delete calendar events", "Let agents use this account"],
    },
  };
}

googleRouter.get("/api/google/status", h((_req, res) => res.json(status())));

// ---------- recovery prerequisites ----------

googleRouter.post("/api/google/recovery/key-saved", h((req, res) => {
  confirmKeySaved(db(), parse(z.object({ saved: z.boolean() }), req.body).saved);
  res.json(status());
}));
googleRouter.post("/api/google/recovery/check", h((_req, res) => {
  runRestoreCheck(db());
  res.json(status());
}));

// ---------- connect ----------

googleRouter.post("/api/google/connect", h((req, res) => {
  personalOnly(req);
  requireRecentAuth(req);
  const body = parse(z.object({ accountId: z.string().max(60).optional(), spaceId: z.string().max(40).optional(), expectedEmail: z.string().max(120).optional(), label: z.string().max(80).optional() }), req.body);
  res.json(startConnect(db(), body, sessionOf(req)?.id ?? null));
}));

const page = (title: string, body: string, to: string, delay = 1) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="${delay};url=${to}"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#101418;color:#e8eef3;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:24px;text-align:center}a{color:#8fd3ff}</style></head>
<body><main><h1 style="font-size:1.2rem">${title}</h1><p>${body}</p><p><a href="${to}">Back to Nikki</a></p></main></body></html>`;

/** Google sends the browser back here. No tokens ever appear in the address the browser ends on. */
googleRouter.get("/oauth/google/callback", h(async (req, res) => {
  const q = { code: typeof req.query.code === "string" ? req.query.code : undefined, state: typeof req.query.state === "string" ? req.query.state : undefined, error: typeof req.query.error === "string" ? req.query.error : undefined };
  const r = await finishConnect(db(), q);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (r.ok) {
    const d = db();
    // First read in the background: calendar copy and a Gmail check. The account card shows progress.
    syncGoogleCalendar(d, r.accountId, tz()).catch(() => undefined);
    checkGmail(d, r.accountId).catch(() => undefined);
    const to = `/?view=context&google=connected#accounts`;
    return res.status(200).type("html").send(page("Connected", "Your Google account is connected, read-only. Taking you back to Nikki…", to));
  }
  const to = `/?view=context&google=error&reason=${encodeURIComponent(r.reason)}#accounts`;
  return res.status(200).type("html").send(page("Not connected", r.message.replace(/[<>&"]/g, ""), to, 8));
}));

// ---------- accounts ----------

const accountOr404 = (id: string) => {
  const a = googleAccount(db(), id);
  if (!a) throw new UserFacingError("That account doesn't exist.", 404, "not_found");
  return a;
};

googleRouter.post("/api/google/accounts/:id/sync", h(async (req, res) => {
  personalOnly(req);
  const a = accountOr404(String(req.params.id));
  forgetGmailCache(a.id);
  const out: Record<string, unknown> = {};
  if (a.services.includes("calendar")) out.calendar = await syncGoogleCalendar(db(), a.id, tz());
  if (a.services.includes("gmail")) out.gmail = await checkGmail(db(), a.id).catch((e) => ({ error: (e as Error).message }));
  res.json({ ...status(), result: out });
}));

googleRouter.post("/api/google/accounts/:id/disconnect", h(async (req, res) => {
  const a = accountOr404(String(req.params.id));
  forgetGmailCache(a.id);
  const out = await disconnectGoogle(db(), a.id, rebuild());
  res.json({ ...status(), result: out });
}));

googleRouter.delete("/api/google/accounts/:id", h((req, res) => {
  removeGoogleAccount(db(), accountOr404(String(req.params.id)).id, rebuild());
  res.json(status());
}));

googleRouter.patch("/api/google/accounts/:id", h(async (req, res) => {
  const a = accountOr404(String(req.params.id));
  const body = parse(z.object({ calendars: z.array(z.string().max(200)).max(50).optional(), spaceId: z.string().max(40).optional() }), req.body);
  if (body.spaceId && body.spaceId !== a.spaceId) {
    requireRecentAuth(req); // moving an account between spaces changes a security boundary
    setAccountSpace(db(), a.id, body.spaceId);
  }
  if (body.calendars) {
    setCalendarSelection(db(), a.id, body.calendars);
    logActivity(db(), "user", "account.calendars_changed", a.id, { count: body.calendars.length }, a.spaceId);
    if (a.status === "connected") await syncGoogleCalendar(db(), a.id, tz());
  }
  res.json(status());
}));

// ---------- email (read-only) ----------

googleRouter.get("/api/google/email/search", h(async (req, res) => {
  personalOnly(req);
  const q = parse(z.object({ q: z.string().max(400).optional(), accountId: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(50).optional(), fresh: z.string().optional() }), req.query);
  res.json(await searchEmail(db(), { query: q.q ?? "in:inbox", accountId: q.accountId, limit: q.limit ?? 20, fresh: q.fresh === "1" }));
}));

googleRouter.get("/api/google/email/:accountId/threads/:threadId", h(async (req, res) => {
  personalOnly(req);
  res.setHeader("Cache-Control", "no-store");
  res.json(await getConversation(db(), String(req.params.accountId), String(req.params.threadId)));
}));
