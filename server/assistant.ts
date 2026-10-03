import type {
  ChatMessage,
  ContextSuggestion,
  Meeting,
  PlanBlock,
  PlanDraft,
  Proposal,
  Task,
  TaskChange,
  Workspace,
} from "../shared/types.js";
import {
  addMessage,
  createMeeting,
  createTask,
  currentPlan,
  currentPlanVersion,
  DB,
  deleteMessage,
  getProfile,
  latestPendingProposal,
  listMeetings,
  listTasks,
  newId,
  nowIso,
  recentMessages,
  saveProposal,
  supersedePending,
} from "./db.js";
import { demoRespond } from "./demo.js";
import { buildAppState, boundedHistory, SYSTEM_PROMPT } from "./prompt.js";
import { getProvider } from "./provider/index.js";
import { ProviderError, ProviderMessage } from "./provider/types.js";
import { ModelResponse, RESPONSE_JSON_SCHEMA } from "./schema.js";
import { isValidDate, isValidTime, localNow, toMinutes } from "./time.js";
import { findDuplicate, validateMeeting, validatePlanDraft } from "./validate.js";

export class UserFacingError extends Error {
  constructor(message: string, public status = 400, public code = "bad_request", public details?: string[]) {
    super(message);
  }
}

export interface TurnInput {
  ws: Workspace;
  db: DB;
  text: string;
  kind: "chat" | "replan" | "review";
  timezone: string;
  remainingUntil?: string | null;
}

interface Resolved {
  newTasks: Task[];
  newMeetings: Meeting[];
  draft: PlanDraft | null;
  planErrors: string[];
  taskChanges: TaskChange[];
  contextSuggestions: ContextSuggestion[];
  notes: string[];
  refMap: Map<string, string>;
}

const MAX_CAPTURES = 25;

/**
 * Turns a (live or demo) model response into concrete, validated changes
 * WITHOUT writing anything. New tasks get their final ids up front so the plan
 * can reference them and be validated before anything is saved.
 */
export function resolveResponse(
  resp: ModelResponse,
  ctx: { tasks: Task[]; meetings: Meeting[]; date: string; now: string; kind: TurnInput["kind"]; source: Task["source"] },
): Resolved {
  const notes: string[] = [];
  const refMap = new Map<string, string>();
  const byId = new Map(ctx.tasks.map((t) => [t.id, t]));
  const newTasks: Task[] = [];

  for (const c of resp.captured_items.slice(0, MAX_CAPTURES)) {
    if (c.duplicate_of && byId.has(c.duplicate_of)) {
      refMap.set(c.ref, c.duplicate_of);
      continue;
    }
    const dup = findDuplicate(c.title, [...ctx.tasks, ...newTasks]);
    if (dup) {
      refMap.set(c.ref, dup.id);
      continue;
    }
    let deadline = c.deadline;
    if (deadline && !isValidDate(deadline)) {
      notes.push(`Ignored an invalid deadline "${deadline}" for "${c.title}".`);
      deadline = null;
    }
    const ts = nowIso();
    const t: Task = {
      id: newId("t"),
      title: c.title.trim(),
      notes: c.notes ?? "",
      type: c.kind,
      status: "open",
      estimateMinutes: c.estimate_minutes,
      deadline,
      project: c.project,
      createdAt: ts,
      updatedAt: ts,
      completedAt: null,
      source: ctx.source,
    };
    newTasks.push(t);
    refMap.set(c.ref, t.id);
  }

  const newMeetings: Meeting[] = [];
  for (const m of resp.meetings) {
    const all = [...ctx.meetings, ...newMeetings];
    if (all.some((e) => e.start === m.start && e.end === m.end)) continue;
    const errs = validateMeeting(m, all);
    if (errs.length) {
      notes.push(`Didn't add meeting: ${errs[0]}`);
      continue;
    }
    newMeetings.push({ id: newId("m"), date: ctx.date, title: m.title, start: m.start, end: m.end });
  }

  const taskChanges: TaskChange[] = [];
  for (const u of resp.task_updates) {
    if (!byId.has(u.task_id)) {
      notes.push(`Ignored a change to an unknown task (${u.task_id}).`);
      continue;
    }
    taskChanges.push({
      id: newId("tc"),
      taskId: u.task_id,
      change: u.change,
      title: u.title,
      estimateMinutes: u.estimate_minutes,
      deadline: u.deadline && isValidDate(u.deadline) ? u.deadline : null,
      notes: u.notes,
      reason: u.reason,
    });
  }

  const contextSuggestions: ContextSuggestion[] = resp.context_updates
    .filter((c) => c.value.trim())
    .filter((c) => !["workStart", "workEnd"].includes(c.field) || isValidTime(c.value))
    .map((c) => ({ id: newId("cs"), field: c.field, value: c.value.trim(), reason: c.reason, status: "pending" }));

  let draft: PlanDraft | null = null;
  let planErrors: string[] = [];
  if (resp.plan) {
    const p = resp.plan;
    const resolve = (ref: string | null) => (ref ? (refMap.get(ref) ?? ref) : null);
    const allMeetings = [...ctx.meetings, ...newMeetings];
    const nowMin = toMinutes(ctx.now);
    const blocks: PlanBlock[] = [];
    for (const b of p.blocks) {
      // On a replan, past blocks are kept from the confirmed plan; ignore copies.
      if (ctx.kind === "replan" && isValidTime(b.end) && toMinutes(b.end) <= nowMin) continue;
      const meeting =
        b.kind === "meeting" ? allMeetings.find((m) => m.start === b.start && m.end === b.end) ?? null : null;
      blocks.push({
        id: newId("b"),
        start: b.start,
        end: b.end,
        kind: b.kind,
        taskId: b.kind === "focus" || b.kind === "task" ? resolve(b.task_ref) : null,
        meetingId: b.kind === "meeting" ? (meeting?.id ?? null) : null,
        title: b.title || (b.kind === "break" ? "Break" : b.kind === "buffer" ? "Buffer" : "Work"),
      });
    }
    draft = {
      date: ctx.date,
      mainOutcome: p.main_outcome,
      focusTaskId: resolve(p.focus.task_ref),
      focusWhy: p.focus.why,
      supporting: p.supporting.map((s) => ({ taskId: resolve(s.task_ref)!, why: s.why })),
      deferred: p.deferred.map((s) => ({ taskId: resolve(s.task_ref)!, why: s.why })),
      reasons: p.reasons,
      assumptions: p.assumptions,
      window: p.window,
      workBudgetMinutes: p.work_budget_minutes,
      blocks,
    };
    const taskMap = new Map([...ctx.tasks, ...newTasks].map((t) => [t.id, t]));
    planErrors = validatePlanDraft(draft, {
      meetings: allMeetings,
      tasks: taskMap,
      notBefore: ctx.kind === "replan" ? ctx.now : null,
    });
    // Tasks already done shouldn't be scheduled again.
    for (const b of blocks) {
      const t = b.taskId ? taskMap.get(b.taskId) : null;
      if (t?.status === "done") planErrors.push(`"${t.title}" is already completed and shouldn't be scheduled.`);
    }
  }
  return { newTasks, newMeetings, draft, planErrors, taskChanges, contextSuggestions, notes, refMap };
}

function parseModelJson(text: string): { ok: true; value: ModelResponse } | { ok: false; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["Response was not valid JSON."] };
  }
  const parsed = ModelResponse.safeParse(json);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "root"}: ${i.message}`) };
  }
  return { ok: true, value: parsed.data };
}

const inFlight = new Set<Workspace>();

export function isBusy(ws: Workspace) {
  return inFlight.has(ws);
}

/** Runs one assistant turn (live or demo) and persists the results. */
export async function runTurn(input: TurnInput): Promise<{ message: ChatMessage; proposal: Proposal | null }> {
  const { db, ws } = input;
  if (inFlight.has(ws)) throw new UserFacingError("Nikki is still working on your previous message.", 409, "busy");
  const provider = ws === "personal" ? getProvider() : null;
  if (ws === "personal" && !provider) {
    throw new UserFacingError(
      "Live AI isn't set up yet: no ANTHROPIC_API_KEY is configured on the server. Switch to Demo mode, or add your key (see README).",
      503,
      "no_api_key",
    );
  }
  inFlight.add(ws);
  const now = localNow(input.timezone);
  const userMsg = addMessage(db, { role: "user", text: input.text, meta: { kind: input.kind } });
  try {
    const profile = getProfile(db);
    const tasks = listTasks(db);
    const meetings = listMeetings(db, now.date);
    const plan = currentPlan(db, now.date);
    const pending = latestPendingProposal(db);
    const baseVersion = currentPlanVersion(db, now.date);
    const history = recentMessages(db, 40);
    const ctx = { tasks, meetings, date: now.date, now: now.time, kind: input.kind, source: ws === "demo" ? ("demo" as const) : ("nikki" as const) };

    let resp: ModelResponse;
    let resolved: Resolved;
    let demoMeta: Record<string, unknown> = {};

    if (!provider) {
      const lastAssistant = [...history].reverse().find((m) => m.role === "assistant") ?? null;
      const demo = demoRespond({
        text: input.text,
        kind: input.kind,
        remainingUntil: input.remainingUntil,
        profile,
        tasks,
        meetings,
        plan,
        now: now.time,
        lastAssistant,
      });
      resp = demo.response;
      demoMeta = { demo: true, ...demo.meta };
      resolved = resolveResponse(resp, ctx);
      if (resolved.planErrors.length) {
        // Should not happen: the demo scheduler builds valid plans. Fail loudly.
        throw new UserFacingError("Demo planner produced an invalid plan.", 500, "demo_invalid", resolved.planErrors);
      }
    } else {
      const appState = buildAppState({
        profile,
        tasks,
        meetings,
        plan,
        proposal: pending,
        date: now.date,
        time: now.time,
        weekday: now.weekday,
        timezone: input.timezone,
        kind: input.kind,
        remainingUntil: input.remainingUntil,
      });
      const messages: ProviderMessage[] = boundedHistory(history);
      const last = messages[messages.length - 1];
      last.content = `${last.content}\n\n${appState}`;

      let raw = await provider.generate({ system: SYSTEM_PROMPT, messages, schema: RESPONSE_JSON_SCHEMA });
      let parsed = parseModelJson(raw.text);
      let attempts = 1;
      // At most one repair round for malformed or invalid output — never unlimited retries.
      if (!parsed.ok) {
        messages.push({ role: "assistant", content: raw.text });
        messages.push({ role: "user", content: `The app couldn't read that response: ${parsed.errors.join("; ")}. Return the complete response again as valid JSON matching the schema.` });
        raw = await provider.generate({ system: SYSTEM_PROMPT, messages, schema: RESPONSE_JSON_SCHEMA });
        parsed = parseModelJson(raw.text);
        attempts++;
        if (!parsed.ok) throw new ProviderError("Claude returned a response the app couldn't understand. Please try again.", "invalid_output");
      }
      resp = parsed.value;
      resolved = resolveResponse(resp, ctx);
      if (resolved.planErrors.length && attempts < 2) {
        messages.push({ role: "assistant", content: raw.text });
        messages.push({
          role: "user",
          content: `The app checked your proposed plan and found problems:\n- ${resolved.planErrors.join("\n- ")}\nReturn the complete response again with a corrected plan (or plan: null with a question if it can't fit). Keep the same captured_items refs.`,
        });
        raw = await provider.generate({ system: SYSTEM_PROMPT, messages, schema: RESPONSE_JSON_SCHEMA });
        const retry = parseModelJson(raw.text);
        if (retry.ok) {
          resp = retry.value;
          resolved = resolveResponse(resp, ctx);
        }
      }
      if (resolved.planErrors.length) {
        resolved.notes.push(...resolved.planErrors.map((e) => `Plan check: ${e}`));
        resp = {
          ...resp,
          message: `${resp.message}\n\nI couldn't produce a schedule that passes the app's checks (${resolved.planErrors[0]}). Could you tell me more about your available time, or should I try again?`,
        };
        resolved.draft = null;
      }
    }

    return persistTurn(db, { resp, resolved, demoMeta, pending, baseVersion, date: now.date, kind: input.kind });
  } catch (err) {
    // Remove the user's message so a retry doesn't duplicate it; the client keeps the text.
    deleteMessage(db, userMsg.id);
    throw err;
  } finally {
    inFlight.delete(ws);
  }
}

function persistTurn(
  db: DB,
  a: {
    resp: ModelResponse;
    resolved: Resolved;
    demoMeta: Record<string, unknown>;
    pending: Proposal | null;
    baseVersion: number;
    date: string;
    kind: TurnInput["kind"];
  },
) {
  return db.transaction(() => {
    const { resolved, resp } = a;
    for (const t of resolved.newTasks) createTask(db, t);
    for (const m of resolved.newMeetings) createMeeting(db, m);
    let proposal: Proposal | null = null;
    let draft = resolved.draft;
    if (!draft && a.pending?.plan && a.pending.basePlanVersion === a.baseVersion && a.pending.date === a.date) {
      draft = a.pending.plan; // carry an unconfirmed plan forward while clarifying
    }
    const carriedSuggestions = (a.pending?.contextSuggestions ?? []).filter(
      (c) => c.status === "pending" && !resolved.contextSuggestions.some((n) => n.field === c.field && n.value === c.value),
    );
    resolved.contextSuggestions = [...carriedSuggestions, ...resolved.contextSuggestions];
    if (draft || resolved.taskChanges.length || resolved.contextSuggestions.length) {
      supersedePending(db);
      proposal = {
        id: newId("pr"),
        createdAt: nowIso(),
        status: "pending",
        date: a.date,
        kind: a.kind === "replan" ? "replan" : "plan",
        basePlanVersion: a.baseVersion,
        plan: draft,
        taskChanges: resolved.taskChanges,
        contextSuggestions: resolved.contextSuggestions,
        warnings: resolved.notes,
      };
      saveProposal(db, proposal);
    }
    const message = addMessage(db, {
      role: "assistant",
      text: resp.message.trim() || (resp.questions.length ? "A couple of quick questions:" : "Done."),
      meta: {
        ...a.demoMeta,
        kind: a.kind,
        questions: resp.questions.slice(0, 2),
        proposalId: proposal?.id,
        capturedTaskIds: resolved.newTasks.map((t) => t.id),
        addedMeetingIds: resolved.newMeetings.map((m) => m.id),
        notes: resolved.notes.length ? resolved.notes : undefined,
      },
    });
    return { message, proposal };
  })();
}
