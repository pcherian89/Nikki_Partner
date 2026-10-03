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
} from "./db.js";
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
} from "./planOps.js";
import { isValidDate, isValidTime, isValidTimeZone, localNow } from "./time.js";
import { validateMeeting, validatePlanDraft } from "./validate.js";

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

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
    `${SESSION_COOKIE}=${sessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}${config.isProduction ? "; Secure" : ""}`,
  );
  res.json({ ok: true });
});

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
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

app.get("/api/state", h((req, res) => res.json({ state: state(req, ctx(req)) })));

const MessageBody = z.object({
  text: z.string().trim().min(1).max(8000),
  clientRequestId: z.string().min(8).max(100),
  kind: z.enum(["chat", "review"]).default("chat"),
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
  project: z.string().max(200).nullable(),
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
    const task = updateTask(c.db, String(req.params.id), body);
    if (!task) throw new UserFacingError("Task not found.", 404, "not_found");
    res.json({ state: state(req, c), task });
  }),
);

app.delete(
  "/api/tasks/:id",
  h((req, res) => {
    const c = ctx(req);
    if (!getTask(c.db, String(req.params.id))) throw new UserFacingError("Task not found.", 404, "not_found");
    const today = localNow(c.tz).date;
    const plan = currentPlan(c.db, today);
    deleteTask(c.db, String(req.params.id));
    // Keep today's plan consistent: drop blocks for the deleted task.
    if (plan && plan.blocks.some((b) => b.taskId === String(req.params.id))) {
      const { id: _i, version, status: _s, createdAt: _c, proposalId: _p, source: _so, ...draft } = plan;
      savePlanVersion(
        c.db,
        {
          ...draft,
          focusTaskId: draft.focusTaskId === String(req.params.id) ? null : draft.focusTaskId,
          supporting: draft.supporting.filter((s) => s.taskId !== String(req.params.id)),
          deferred: draft.deferred.filter((s) => s.taskId !== String(req.params.id)),
          blocks: draft.blocks.filter((b) => b.taskId !== String(req.params.id)),
        },
        { expectedVersion: version, proposalId: null, source: "user-edit" },
      );
    }
    res.json({ state: state(req, c) });
  }),
);

const MeetingBody = z.object({ title: z.string().trim().min(1).max(200), start: z.string(), end: z.string() });

/** After a meeting changes, rebuild today's plan's meeting blocks if the plan still fits. */
function syncPlanMeetings(c: Ctx): string | null {
  const today = localNow(c.tz).date;
  const plan = currentPlan(c.db, today);
  if (!plan) return null;
  const meetings = listMeetings(c.db, today);
  const blocks = [
    ...plan.blocks.filter((b) => b.kind !== "meeting"),
    ...meetings.map((m) => ({ id: `b_${m.id}`, start: m.start, end: m.end, kind: "meeting" as const, taskId: null, meetingId: m.id, title: m.title })),
  ].sort((a, b) => a.start.localeCompare(b.start));
  const { id: _i, version, status: _s, createdAt: _c, proposalId: _p, source: _so, ...rest } = plan;
  const draft = { ...rest, blocks };
  const tasks = new Map(
    (c.db.prepare("SELECT id FROM tasks WHERE deleted = 0").all() as { id: string }[]).map((t) => [t.id, t as never]),
  );
  const errors = validatePlanDraft(draft, { meetings, tasks });
  if (errors.length) return `Your meetings changed and today's plan no longer fits (${errors[0]}). Use “Update my plan” to rework it.`;
  savePlanVersion(c.db, draft, { expectedVersion: version, proposalId: null, source: "user-edit" });
  return null;
}

app.post(
  "/api/meetings",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(MeetingBody, req.body);
    const date = localNow(c.tz).date;
    const errors = validateMeeting(body, listMeetings(c.db, date));
    if (errors.length) throw new UserFacingError(errors[0], 422, "invalid_meeting", errors);
    createMeeting(c.db, { ...body, date });
    const warning = syncPlanMeetings(c);
    res.json({ state: state(req, c), warning });
  }),
);

app.patch(
  "/api/meetings/:id",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(MeetingBody, req.body);
    const date = localNow(c.tz).date;
    const errors = validateMeeting(body, listMeetings(c.db, date), String(req.params.id));
    if (errors.length) throw new UserFacingError(errors[0], 422, "invalid_meeting", errors);
    if (!updateMeeting(c.db, String(req.params.id), body)) throw new UserFacingError("Meeting not found.", 404, "not_found");
    const warning = syncPlanMeetings(c);
    res.json({ state: state(req, c), warning });
  }),
);

app.delete(
  "/api/meetings/:id",
  h((req, res) => {
    const c = ctx(req);
    deleteMeeting(c.db, String(req.params.id));
    const warning = syncPlanMeetings(c);
    res.json({ state: state(req, c), warning });
  }),
);

app.put(
  "/api/plan",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(z.object({ expectedVersion: z.number().int().min(0), plan: z.unknown() }), req.body);
    editPlan(c.db, body, c.tz);
    res.json({ state: state(req, c) });
  }),
);

app.post(
  "/api/review",
  h((req, res) => {
    const c = ctx(req);
    const body = parse(
      z.object({ decisions: z.array(z.object({ taskId: z.string(), action: z.enum(["keep", "done", "park", "drop"]) })).max(100) }),
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
      note: "Everything Nikki Partner has stored for this workspace. This data lives in the app's own database; it is sent to the model only as context for a request and is not used for model training.",
    };
    for (const t of ["profile", "tasks", "messages", "meetings", "proposals", "plans", "plan_blocks", "settings"]) {
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
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
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
  for (const ws of ["personal", "demo"] as const) recoverRequests(getDb(ws));
  app.listen(config.port, () => {
    console.log(`Nikki Partner server running on http://localhost:${config.port}`);
    console.log(`  Personal data: ${dbPath("personal")}`);
    console.log(`  Demo data:     ${dbPath("demo")}`);
    console.log(
      getProvider()
        ? `  Live AI: ON (model ${config.model})`
        : "  Live AI: OFF (no ANTHROPIC_API_KEY) — Demo mode works; personal workspace can store data but can't call Claude.",
    );
    if (config.appPassword) console.log("  Password protection: ON");
  });
}
