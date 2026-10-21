import express, { NextFunction, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Workspace } from "../shared/types.js";
import { CONTEXT_FIELDS } from "../shared/types.js";
import { isBusy, runTurn, UserFacingError } from "./assistant.js";
import { config } from "./config.js";
import {
  beginRequest,
  createMeeting,
  createTask,
  currentPlan,
  DB,
  dbPath,
  closeAll,
  deleteMeeting,
  deleteTask,
  finishRequest,
  getDb,
  getProfile,
  getTask,
  listMeetings,
  recoverRequests,
  saveProfile,
  savePlanVersion,
  updateMeeting,
  updateTask,
  wipe,
  TABLES,
  setTimer,
  replaceSteps,
  setStepDone,
  deleteDraft,
  getSetting,
  setSetting,
} from "./db.js";
import { breakDown, helpMeStart } from "./helpers.js";
import { importWorkspace } from "./importer.js";
import { addFeed, removeFeed, syncFeed, syncStale } from "./calendar.js";
import { buildIcs, disableFeed, getFeedToken, resetFeedToken } from "./icsExport.js";
import { getProvider } from "./provider/index.js";
import { ProviderError } from "./provider/types.js";
import {
  applyContextSuggestion,
  buildState,
  confirmProposal,
  discardProposal,
  editPlan,
  resolveTimezone,
  reviewNewDay,
  wrapUpDay,
  rebuildPlanMeetings,
  deleteTaskEverywhere,
  removeTaskFromPlan,
  rescheduleTask,
} from "./planOps.js";
import { addDays, isValidDate, isValidTime, isValidTimeZone, localNow } from "./time.js";
import { validateMeeting, validatePlanDraft } from "./validate.js";

export const app = express();
app.disable("x-powered-by");
// Hosts like Railway terminate HTTPS in front of the app; trust that so req.secure works.
app.set("trust proxy", 1);
const smallJson = express.json({ limit: "256kb" });
// Data import gets its own, larger limit (see /api/import).
app.use((req, res, next) => (req.path === "/api/import" ? next() : smallJson(req, res, next)));

// ---------- optional password protection (required for public hosting) ----------

const SESSION_COOKIE = "nikki_session";
const sessionToken = () => createHmac("sha256", config.appPassword).update("nikki-session-v1").digest("hex");

function readCookie(req: Request, name: string) {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function isAuthed(req: Request) {
  if (!config.appPassword) return true;
  const c = readCookie(req, SESSION_COOKIE);
  if (!c) return false;
  const a = Buffer.from(c);
  const b = Buffer.from(sessionToken());
  return a.length === b.length && timingSafeEqual(a, b);
}

const loginAttempts = new Map<string, { count: number; until: number }>();

app.get("/api/auth/status", (req, res) => {
  res.json({ authRequired: !!config.appPassword, authed: isAuthed(req) });
});

app.post("/api/auth/login", (req, res) => {
  const ip = req.ip ?? "unknown";
  const rec = loginAttempts.get(ip);
  if (rec && rec.count >= 5 && Date.now() < rec.until) {
    return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
  }
  const pw = String(req.body?.password ?? "");
  const a = Buffer.from(createHmac("sha256", "cmp").update(pw).digest("hex"));
  const b = Buffer.from(createHmac("sha256", "cmp").update(config.appPassword).digest("hex"));
  if (!config.appPassword || !timingSafeEqual(a, b)) {
    loginAttempts.set(ip, { count: (rec?.count ?? 0) + 1, until: Date.now() + 5 * 60_000 });
    return res.status(401).json({ error: "Wrong password." });
  }
  loginAttempts.delete(ip);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${sessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}${req.secure ? "; Secure" : ""}`,
  );
  res.json({ ok: true });
});

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// Public but secret: calendar apps can't log in, so the long random token is the key.
app.get("/cal/:file", (req, res) => {
  const token = String(req.params.file).replace(/\.ics$/, "");
  const match = (["personal", "demo"] as const).find((ws) => {
    const t = getFeedToken(getDb(ws));
    if (!t || t.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(t), Buffer.from(token));
  });
  if (!match) return res.status(404).type("text/plain").send("Not found");
  const db = getDb(match);
  const tz = resolveTimezone(getProfile(db), getSetting(db, "last_timezone") ?? undefined);
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(buildIcs(db, tz));
});

app.use("/api", (req, res, next) => {
  if (req.path === "/health" || isAuthed(req)) return next();
  res.status(401).json({ error: "Please log in.", code: "auth_required" });
});

// ---------- helpers ----------

interface Ctx {
  ws: Workspace;
  db: DB;
  tz: string;
}

function ctx(req: Request): Ctx {
  const ws: Workspace = req.header("x-workspace") === "demo" ? "demo" : "personal";
  const db = getDb(ws);
  const tz = resolveTimezone(getProfile(db), req.header("x-timezone"));
  // Remembered so background calendar sync uses the user's local time.
  if (getSetting(db, "last_timezone") !== tz) setSetting(db, "last_timezone", tz);
  return { ws, db, tz };
}

const state = (req: Request, c: Ctx) => buildState(c.db, c.ws, req.header("x-timezone"));

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new UserFacingError("Invalid request.", 400, "invalid", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  return r.data;
}

// ---------- routes ----------

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, liveAvailable: getProvider() !== null, model: getProvider() ? config.model : null });
});

app.get(
  "/api/state",
  h((req, res) => {
    const c = ctx(req);
    syncStale(c.db, c.tz); // refresh linked calendars in the background if they're stale
    res.json({ state: state(req, c) });
  }),
);

// ---------- "Nikki in your calendar" subscription feed ----------

app.post(
  "/api/calendar-feed",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(z.object({ action: z.enum(["create", "reset", "disable"]) }), req.body);
    if (body.action === "disable") disableFeed(c.db);
    else if (body.action === "reset" || !getFeedToken(c.db)) resetFeedToken(c.db);
    res.json({ state: state(req, c) });
  }),
);

// ---------- linked calendars (read-only) ----------

app.post(
  "/api/calendars",
  h(async (req, res) => {
    const c = ctx(req);
    const body = parse(z.object({ name: z.string().max(60).default(""), url: z.string().min(8).max(2000) }), req.body);
    const r = await addFeed(c.db, body.name, body.url, c.tz);
    res.json({ state: state(req, c), warning: r.warnings[0] ?? null });
  }),
);

app.post(
  "/api/calendars/:id/sync",
  h(async (req, res) => {
    const c = ctx(req);
    const r = await syncFeed(c.db, String(req.params.id), c.tz);
    res.json({ state: state(req, c), warning: r.warnings[0] ?? null });
  }),
);

app.delete(
  "/api/calendars/:id",
  h((req, res) => {
    const c = ctx(req);
    removeFeed(c.db, String(req.params.id), c.tz);
    res.json({ state: state(req, c) });
  }),
);

const MessageBody = z.object({
  text: z.string().trim().min(1).max(8000),
  clientRequestId: z.string().min(8).max(100),
  kind: z.enum(["chat", "review", "wrapup"]).default("chat"),
});

const ReplanBody = z.object({
  clientRequestId: z.string().min(8).max(100),
  remainingUntil: z.string().refine(isValidTime, "Use HH:MM").nullable().optional(),
  note: z.string().max(2000).optional(),
});

/** Runs a model turn with duplicate-submission protection. */
async function idempotentTurn(req: Request, res: Response, c: Ctx, requestId: string, run: () => Promise<unknown>) {
  const begun = beginRequest(c.db, `${c.ws}:${requestId}`);
  if (begun.state === "done") return res.json({ state: state(req, c), duplicate: true });
  if (begun.state === "running" || isBusy(c.ws)) {
    if (begun.state === "new") finishRequest(c.db, `${c.ws}:${requestId}`, false);
    return res.status(409).json({ error: "Nikki is still working on your previous message.", code: "busy" });
  }
  try {
    await run();
    finishRequest(c.db, `${c.ws}:${requestId}`, true, { ok: true });
  } catch (e) {
    finishRequest(c.db, `${c.ws}:${requestId}`, false);
    throw e;
  }
  res.json({ state: state(req, c) });
}

app.post(
  "/api/messages",
  h(async (req, res) => {
    const c = ctx(req);
    const body = parse(MessageBody, req.body);
    await idempotentTurn(req, res, c, body.clientRequestId, () =>
      runTurn({ ws: c.ws, db: c.db, text: body.text, kind: body.kind, timezone: c.tz }),
    );
  }),
);

app.post(
  "/api/replan",
  h(async (req, res) => {
    const c = ctx(req);
    const body = parse(ReplanBody, req.body);
    const text = [
      "Please update my plan for the rest of today.",
      body.remainingUntil ? `I can work until ${body.remainingUntil}.` : "",
      body.note?.trim() ?? "",
    ]
      .filter(Boolean)
      .join(" ");
    await idempotentTurn(req, res, c, body.clientRequestId, () =>
      runTurn({ ws: c.ws, db: c.db, text, kind: "replan", timezone: c.tz, remainingUntil: body.remainingUntil ?? null }),
    );
  }),
);

app.post(
  "/api/proposals/:id/confirm",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(z.object({ plan: z.unknown().optional(), acceptedTaskChangeIds: z.array(z.string()).optional() }), req.body ?? {});
    const r = confirmProposal(c.db, String(req.params.id), { ...body, timezone: c.tz, source: c.ws === "demo" ? "demo" : "nikki" });
    res.json({ state: state(req, c), ...r });
  }),
);

app.post(
  "/api/proposals/:id/discard",
  h((req, res) => {
    const c = ctx(req);
    discardProposal(c.db, String(req.params.id));
    res.json({ state: state(req, c) });
  }),
);

app.post(
  "/api/proposals/:id/suggestions/:sid",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(z.object({ action: z.enum(["save", "dismiss"]), value: z.string().max(4000).optional() }), req.body);
    applyContextSuggestion(c.db, String(req.params.id), String(req.params.sid), body.action, body.value);
    res.json({ state: state(req, c) });
  }),
);

const ProfileBody = z.object(
  Object.fromEntries(CONTEXT_FIELDS.map((f) => [f, z.string().max(4000).optional()])) as Record<(typeof CONTEXT_FIELDS)[number], z.ZodOptional<z.ZodString>>,
);

app.put(
  "/api/profile",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(ProfileBody, req.body);
    for (const f of ["workStart", "workEnd"] as const) {
      if (body[f] && !isValidTime(body[f])) throw new UserFacingError(`Working hours must be HH:MM (24-hour).`);
    }
    if (body.timezone && !isValidTimeZone(body.timezone)) throw new UserFacingError(`"${body.timezone}" isn't a recognised timezone.`);
    const profile = { ...getProfile(c.db), ...Object.fromEntries(Object.entries(body).map(([k, v]) => [k, (v ?? "").trim()])) };
    saveProfile(c.db, profile);
    res.json({ state: state(req, c) });
  }),
);

const TaskFields = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(4000),
  type: z.enum(["action", "idea", "reference"]),
  status: z.enum(["open", "waiting", "blocked", "done"]),
  estimateMinutes: z.number().int().positive().max(24 * 60).nullable(),
  deadline: z.string().refine(isValidDate, "Use YYYY-MM-DD").nullable(),
  plannedDate: z.string().refine(isValidDate, "Use YYYY-MM-DD").nullable(),
  project: z.string().max(200).nullable(),
  actualMinutes: z.number().int().positive().max(24 * 60).nullable(),
});

app.post(
  "/api/tasks",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(TaskFields.partial().required({ title: true }), req.body);
    const task = createTask(c.db, { ...body, source: "user" });
    res.json({ state: state(req, c), task });
  }),
);

app.patch(
  "/api/tasks/:id",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(TaskFields.partial(), req.body);
    const id = String(req.params.id);
    const task = c.db.transaction(() => {
      const t = updateTask(c.db, id, body);
      // Planning it for another day takes it off today's / tomorrow's plan.
      if (t && body.plannedDate !== undefined) {
        const today = localNow(c.tz).date;
        for (const d of [today, addDays(today, 1)]) if (d !== body.plannedDate) removeTaskFromPlan(c.db, d, id, body.plannedDate ? `Moved to ${body.plannedDate}.` : "Moved to someday.");
      }
      return t;
    })();
    if (!task) throw new UserFacingError("Task not found.", 404, "not_found");
    res.json({ state: state(req, c), task });
  }),
);

app.post(
  "/api/tasks/:id/reschedule",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(
      z.discriminatedUnion("to", [
        z.object({ to: z.literal("later_today") }),
        z.object({ to: z.literal("date"), date: z.string().refine(isValidDate, "Use YYYY-MM-DD") }),
        z.object({ to: z.literal("someday") }),
      ]),
      req.body,
    );
    const r = rescheduleTask(c.db, String(req.params.id), body, c.tz);
    res.json({ state: state(req, c), message: r.message });
  }),
);

app.delete(
  "/api/tasks/:id",
  h((req, res) => {
    const c = ctx(req);
    if (!getTask(c.db, String(req.params.id))) throw new UserFacingError("Task not found.", 404, "not_found");
    // Also takes it off today's and tomorrow's plans, so nothing points at a deleted task.
    c.db.transaction(() => deleteTaskEverywhere(c.db, String(req.params.id), localNow(c.tz).date))();
    res.json({ state: state(req, c) });
  }),
);

// ---------- focus timer, steps, drafts, wrap-up ----------

app.post(
  "/api/tasks/:id/timer",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(z.object({ action: z.enum(["start", "stop"]) }), req.body);
    if (!setTimer(c.db, String(req.params.id), body.action)) throw new UserFacingError("Task not found.", 404, "not_found");
    res.json({ state: state(req, c) });
  }),
);

app.post(
  "/api/tasks/:id/breakdown",
  h(async (req, res) => {
    const c = ctx(req);
    const result = await breakDown(c.db, c.ws, String(req.params.id));
    res.json(result);
  }),
);

app.put(
  "/api/tasks/:id/steps",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(
      z.object({
        steps: z
          .array(
            z.object({
              id: z.string().optional(),
              title: z.string().trim().min(1).max(200),
              minutes: z.number().int().min(1).max(480).nullable(),
              done: z.boolean().optional(),
            }),
          )
          .max(20),
      }),
      req.body,
    );
    if (!getTask(c.db, String(req.params.id))) throw new UserFacingError("Task not found.", 404, "not_found");
    replaceSteps(c.db, String(req.params.id), body.steps);
    res.json({ state: state(req, c) });
  }),
);

app.patch(
  "/api/steps/:id",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(z.object({ done: z.boolean() }), req.body);
    if (!setStepDone(c.db, String(req.params.id), body.done)) throw new UserFacingError("Step not found.", 404, "not_found");
    res.json({ state: state(req, c) });
  }),
);

app.post(
  "/api/tasks/:id/assist",
  h(async (req, res) => {
    const c = ctx(req);
    const body = parse(z.object({ ask: z.string().max(1000).default("") }), req.body ?? {});
    const draft = await helpMeStart(c.db, c.ws, String(req.params.id), body.ask);
    res.json({ state: state(req, c), draft });
  }),
);

app.delete(
  "/api/drafts/:id",
  h((req, res) => {
    const c = ctx(req);
    deleteDraft(c.db, String(req.params.id));
    res.json({ state: state(req, c) });
  }),
);

app.post(
  "/api/wrapup",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(
      z.object({
        decisions: z.array(z.object({ taskId: z.string(), action: z.enum(["tomorrow", "date", "done", "someday", "drop"]), date: z.string().refine(isValidDate).optional() })).max(100),
        note: z.string().max(4000).default(""),
      }),
      req.body,
    );
    wrapUpDay(c.db, body, c.tz);
    res.json({ state: state(req, c) });
  }),
);

const MeetingBody = z.object({
  title: z.string().trim().min(1).max(200),
  start: z.string(),
  end: z.string(),
  date: z.string().refine(isValidDate, "Use YYYY-MM-DD").optional(),
});

function meetingById(c: Ctx, id: string) {
  return c.db.prepare("SELECT id, date, title, start, end, source FROM meetings WHERE id = ? AND deleted = 0").get(id) as
    | { id: string; date: string; title: string; start: string; end: string; source: string }
    | undefined;
}

function syncPlanMeetings(c: Ctx, date: string): string | null {
  return rebuildPlanMeetings(c.db, date, localNow(c.tz).date);
}

app.post(
  "/api/meetings",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(MeetingBody, req.body);
    const today = localNow(c.tz).date;
    const date = body.date ?? today;
    if (date < today) throw new UserFacingError("That date is in the past.");
    const errors = validateMeeting(body, listMeetings(c.db, date));
    if (errors.length) throw new UserFacingError(errors[0], 422, "invalid_meeting", errors);
    createMeeting(c.db, { title: body.title, start: body.start, end: body.end, date });
    const warning = syncPlanMeetings(c, date);
    res.json({ state: state(req, c), warning });
  }),
);

app.patch(
  "/api/meetings/:id",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(MeetingBody, req.body);
    const cur = meetingById(c, String(req.params.id));
    if (!cur) throw new UserFacingError("Meeting not found.", 404, "not_found");
    if (cur.source === "calendar") throw new UserFacingError("This event comes from your linked calendar — change it there.", 400, "read_only");
    const date = body.date ?? cur.date;
    if (date < localNow(c.tz).date) throw new UserFacingError("That date is in the past.");
    const errors = validateMeeting(body, listMeetings(c.db, date), cur.id);
    if (errors.length) throw new UserFacingError(errors[0], 422, "invalid_meeting", errors);
    updateMeeting(c.db, cur.id, { title: body.title, start: body.start, end: body.end, date });
    const warning = syncPlanMeetings(c, cur.date) ?? (date !== cur.date ? syncPlanMeetings(c, date) : null);
    res.json({ state: state(req, c), warning });
  }),
);

app.delete(
  "/api/meetings/:id",
  h((req, res) => {
    const c = ctx(req);
    const cur = meetingById(c, String(req.params.id));
    if (cur?.source === "calendar") throw new UserFacingError("This event comes from your linked calendar — remove it there.", 400, "read_only");
    deleteMeeting(c.db, String(req.params.id));
    const warning = cur ? syncPlanMeetings(c, cur.date) : null;
    res.json({ state: state(req, c), warning });
  }),
);

app.put(
  "/api/plan",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(
      z.object({ expectedVersion: z.number().int().min(0), plan: z.unknown(), date: z.string().refine(isValidDate).optional() }),
      req.body,
    );
    editPlan(c.db, body, c.tz);
    res.json({ state: state(req, c) });
  }),
);

app.post(
  "/api/review",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(
      z.object({
        decisions: z
          .array(z.object({ taskId: z.string(), action: z.enum(["today", "tomorrow", "date", "done", "someday", "drop"]), date: z.string().refine(isValidDate).optional() }))
          .max(100),
      }),
      req.body,
    );
    reviewNewDay(c.db, body.decisions, c.tz);
    res.json({ state: state(req, c) });
  }),
);

app.get(
  "/api/export",
  h((req, res) => {
    const c = ctx(req);
    const dump: Record<string, unknown> = {
      exportedAt: new Date().toISOString(),
      workspace: c.ws,
      note: "Everything Nikki has stored for this workspace. This data lives in the app's own database; it is sent to the model only as context for a request and is not used for model training.",
    };
    for (const t of TABLES.filter((x) => x !== "requests")) {
      dump[t] = (c.db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]).map((r) => {
        for (const k of ["data", "meta"]) if (typeof r[k] === "string") r[k] = JSON.parse(r[k] as string);
        return r;
      });
    }
    res.setHeader("Content-Disposition", `attachment; filename="nikki-${c.ws}-export-${localNow(c.tz).date}.json"`);
    res.json(dump);
  }),
);

app.delete(
  "/api/data",
  h((req, res) => {
    const c = ctx(req);
    parse(z.object({ confirm: z.literal("DELETE") }), req.body);
    wipe(c.db);
    c.db.exec("VACUUM");
    res.json({ state: state(req, c) });
  }),
);

app.post(
  "/api/import",
  express.json({ limit: "20mb" }),
  h((req, res) => {
    const c = ctx(req);
    const body = parse(z.object({ confirm: z.literal("REPLACE"), data: z.record(z.string(), z.unknown()) }), req.body);
    importWorkspace(c.db, body.data);
    res.json({ state: state(req, c) });
  }),
);

app.post(
  "/api/demo/reset",
  h((req, res) => {
    const db = getDb("demo");
    wipe(db);
    res.json({ state: buildState(db, "demo", req.header("x-timezone")) });
  }),
);

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

// ---------- static frontend (production build) ----------

const distDir = path.resolve("dist");
if (fs.existsSync(path.join(distDir, "index.html"))) {
  app.use(
    express.static(distDir, {
      index: false,
      // Hashed build assets never change; everything else (e.g. Nikki's images) is revalidated
      // on each load so a replaced image shows up immediately.
      setHeaders: (res, filePath) => {
        res.setHeader("Cache-Control", filePath.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    }),
  );
  // The page itself is never cached, so opening the app always picks up the latest version.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(distDir, "index.html"));
  });
}

// ---------- errors ----------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof UserFacingError) {
    return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
  }
  if (err instanceof ProviderError) {
    console.warn(`[claude] ${err.code}: ${err.message}`);
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if ((err as { type?: string })?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body." });
  }
  console.error("[server] unexpected error:", (err as Error)?.message ?? err);
  res.status(500).json({ error: "Something went wrong on the server. Your saved data is unchanged." });
});

// ---------- start ----------

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("server", "index.ts"));
if (isMain) {
  console.log(`Starting Nikki (Node ${process.version})…`);
  process.on("exit", (code) => {
    if (code !== 0) console.error(`Nikki stopped with exit code ${code}.`);
  });
}
if (isMain && config.publicDeployment && config.appPassword.length < 10) {
  console.error(
    "Refusing to start: this is a hosted deployment, so APP_PASSWORD must be set to a strong password (at least 10 characters) to protect your data and API key.",
  );
  process.exit(1);
}

if (isMain) {
  for (const ws of ["personal", "demo"] as const) recoverRequests(getDb(ws));
  // Keep linked calendars fresh even when nobody has the app open.
  setInterval(() => {
    for (const ws of ["personal", "demo"] as const) {
      const db = getDb(ws);
      syncStale(db, resolveTimezone(getProfile(db), getSetting(db, "last_timezone") ?? undefined));
    }
  }, 15 * 60 * 1000).unref();
  const server = app.listen(config.port, () => {
    console.log(`Nikki is running on http://localhost:${config.port}`);
    console.log(`  Personal data: ${dbPath("personal")}`);
    if (config.movedIntoVolume) console.log(`  (DATABASE_PATH ${config.movedIntoVolume} is outside the volume, so the volume path is used instead.)`);
    if (config.storageWarning) console.error(`  WARNING: ${config.storageWarning}`);
    console.log(`  Demo data:     ${dbPath("demo")}`);
    console.log(
      getProvider()
        ? `  Live AI: ON (model ${config.model})`
        : "  Live AI: OFF (no ANTHROPIC_API_KEY) — Demo mode works; personal workspace can store data but can't call Claude.",
    );
    if (config.appPassword) console.log("  Password protection: ON");
  });
  // Railway stops the old copy with SIGTERM when it deploys an update. Finish open requests, close the
  // databases and exit normally, so an update isn't reported as a crash.
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}: shutting down cleanly for an update or restart.`);
    server.close(() => {
      closeAll();
      process.exit(0);
    });
    setTimeout(() => {
      closeAll();
      process.exit(0);
    }, 8000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  // Log anything unexpected with its cause, so a real crash can be diagnosed from the deploy logs.
  process.on("unhandledRejection", (reason) => console.error("Unhandled error (kept running):", reason));
  process.on("uncaughtException", (err) => {
    console.error("Fatal error:", err);
    closeAll();
    process.exit(1);
  });
}
