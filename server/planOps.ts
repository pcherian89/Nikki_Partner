import { z } from "zod";
import type { AppState, PlanBlock, PlanDraft, Profile, Task, Workspace } from "../shared/types.js";
import { CONTEXT_FIELDS } from "../shared/types.js";
import { UserFacingError } from "./assistant.js";
import { config } from "./config.js";
import {
  currentPlan,
  currentPlanVersion,
  DB,
  deleteTask,
  getProfile,
  getProposal,
  getSetting,
  latestPendingProposal,
  latestPlanBefore,
  listMeetings,
  listTasks,
  newId,
  planVersions,
  recentMessages,
  saveProfile,
  savePlanVersion,
  saveProposal,
  setProposalStatus,
  setSetting,
  StalePlanError,
  updateTask,
  listDrafts,
  wrapUpFor,
  lastWrapUpBefore,
  saveWrapUp,
  addMessage,
} from "./db.js";
import { getProvider } from "./provider/index.js";
import { estimationInsight } from "./learning.js";
import { fromMinutes, isValidTimeZone, isValidTime, localDateOf, localNow, toMinutes } from "./time.js";
import { validatePlanDraft, WORK_KINDS } from "./validate.js";

export function resolveTimezone(profile: Profile, headerTz: string | undefined): string {
  if (isValidTimeZone(profile.timezone)) return profile.timezone;
  if (isValidTimeZone(headerTz)) return headerTz;
  return "UTC";
}

export function buildState(db: DB, ws: Workspace, headerTz: string | undefined): AppState {
  const profile = getProfile(db);
  const tz = resolveTimezone(profile, headerTz);
  const now = localNow(tz);
  const tasks = listTasks(db);
  const plan = currentPlan(db, now.date);
  let proposal = latestPendingProposal(db);
  if (proposal && proposal.date !== now.date && proposal.plan) proposal = { ...proposal, status: "stale" };

  let newDay: AppState["newDay"] = null;
  if (!plan && getSetting(db, "review_done") !== now.date) {
    const last = latestPlanBefore(db, now.date);
    // A wrap-up on that day already decided what happens to unfinished work.
    if (last && !wrapUpFor(db, last.date)) {
      const ids = new Set<string>();
      for (const b of last.blocks) if (b.taskId && WORK_KINDS.has(b.kind)) ids.add(b.taskId);
      if (last.focusTaskId) ids.add(last.focusTaskId);
      last.supporting.forEach((s) => ids.add(s.taskId));
      const unfinished = tasks.filter((t) => ids.has(t.id) && t.status !== "done").map((t) => t.id);
      if (unfinished.length) newDay = { lastPlanDate: last.date, unfinishedTaskIds: unfinished };
    }
  }
  const messages = recentMessages(db, 80);
  return {
    workspace: ws,
    liveAvailable: getProvider() !== null,
    model: ws === "personal" && getProvider() ? config.model : null,
    authRequired: !!config.appPassword,
    today: now.date,
    now: now.time,
    weekday: now.weekday,
    timezone: tz,
    profile,
    tasks,
    meetings: listMeetings(db, now.date),
    plan,
    planVersions: planVersions(db, now.date),
    proposal,
    newDay,
    messages,
    drafts: listDrafts(db),
    wrapUpToday: wrapUpFor(db, now.date),
    lastWrapUp: lastWrapUpBefore(db, now.date),
    learning: estimationInsight(tasks),
    hasAnyData: messages.length > 0 || tasks.length > 0 || !!profile.updatedAt,
  };
}

// ---------- plan drafts edited by the user ----------

const BlockInput = z.object({
  id: z.string().optional(),
  start: z.string(),
  end: z.string(),
  kind: z.enum(["focus", "task", "break", "buffer", "meeting"]),
  taskId: z.string().nullable().optional(),
  meetingId: z.string().nullable().optional(),
  title: z.string().max(300),
});

export const PlanDraftInput = z.object({
  mainOutcome: z.string().max(500),
  focusTaskId: z.string().nullable(),
  focusWhy: z.string().max(1000).default(""),
  supporting: z.array(z.object({ taskId: z.string(), why: z.string().max(1000) })).max(5),
  deferred: z.array(z.object({ taskId: z.string(), why: z.string().max(1000) })).max(50),
  reasons: z.array(z.string().max(1000)).max(10).default([]),
  assumptions: z.array(z.string().max(1000)).max(10).default([]),
  window: z.object({ start: z.string(), end: z.string() }),
  workBudgetMinutes: z.number().int().min(0).max(24 * 60),
  blocks: z.array(BlockInput).max(60),
});

function normaliseDraft(date: string, input: z.infer<typeof PlanDraftInput>): PlanDraft {
  return {
    ...input,
    date,
    blocks: input.blocks.map((b) => ({
      id: b.id ?? newId("b"),
      start: b.start,
      end: b.end,
      kind: b.kind,
      taskId: b.taskId ?? null,
      meetingId: b.meetingId ?? null,
      title: b.title,
    })),
  };
}

const sortBlocks = (blocks: PlanBlock[]) => [...blocks].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));

/** Replace meeting blocks with the saved meetings, exactly as saved. */
function withMeetingBlocks(db: DB, date: string, blocks: PlanBlock[]) {
  const meetings = listMeetings(db, date);
  const existing = new Map(blocks.filter((b) => b.kind === "meeting" && b.meetingId).map((b) => [b.meetingId!, b.id]));
  const meetingBlocks: PlanBlock[] = meetings.map((m) => ({
    id: existing.get(m.id) ?? newId("b"),
    start: m.start,
    end: m.end,
    kind: "meeting",
    taskId: null,
    meetingId: m.id,
    title: m.title,
  }));
  return { meetings, blocks: sortBlocks([...blocks.filter((b) => b.kind !== "meeting"), ...meetingBlocks]) };
}

function taskMap(db: DB) {
  return new Map(listTasks(db).map((t) => [t.id, t] as [string, Task]));
}

export function confirmProposal(
  db: DB,
  id: string,
  opts: { plan?: unknown; acceptedTaskChangeIds?: string[]; timezone: string; source: "nikki" | "demo" },
) {
  const p = getProposal(db, id);
  if (!p) throw new UserFacingError("Proposal not found.", 404, "not_found");
  if (p.status === "confirmed") return { alreadyConfirmed: true };
  if (p.status !== "pending") {
    throw new UserFacingError("This proposal is no longer current. Ask Nikki for an updated plan.", 409, "stale");
  }
  const now = localNow(opts.timezone);
  if (p.plan && p.date !== now.date) {
    setProposalStatus(db, p.id, "stale");
    throw new UserFacingError(`This proposal was for ${p.date}. Let's plan today instead.`, 409, "stale");
  }
  const curVersion = currentPlanVersion(db, p.date);
  if (p.plan && p.basePlanVersion !== curVersion) {
    setProposalStatus(db, p.id, "stale");
    throw new UserFacingError(
      "Your plan was changed after Nikki made this proposal, so it wasn't applied. Ask for an update to get a fresh proposal.",
      409,
      "stale",
    );
  }

  return db.transaction(() => {
    const accepted = new Set(opts.acceptedTaskChangeIds ?? p.taskChanges.map((c) => c.id));
    for (const c of p.taskChanges) {
      if (!accepted.has(c.id)) continue;
      applyTaskChange(db, c);
    }

    if (p.plan) {
      let draft = p.plan;
      if (opts.plan !== undefined) {
        const parsed = PlanDraftInput.safeParse(opts.plan);
        if (!parsed.success) throw new UserFacingError("The edited plan is malformed.", 400, "invalid", parsed.error.issues.map((i) => i.message));
        draft = normaliseDraft(p.date, parsed.data);
      }
      const current = currentPlan(db, p.date);
      const tasks = taskMap(db);
      const nowMin = toMinutes(now.time);
      const newBlocks = draft.blocks.filter((b) => b.kind !== "meeting");
      // Preserve completed work and the past from the current confirmed plan.
      const preserved = (current?.blocks ?? []).filter((b) => {
        if (b.kind === "meeting") return false;
        const done = b.taskId ? tasks.get(b.taskId)?.status === "done" : false;
        const past = toMinutes(b.end) <= nowMin;
        if (!(done || past)) return false;
        return !newBlocks.some((n) => toMinutes(n.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(n.end));
      });
      const preservedWork = preserved.filter((b) => WORK_KINDS.has(b.kind)).reduce((s, b) => s + toMinutes(b.end) - toMinutes(b.start), 0);
      const { meetings, blocks } = withMeetingBlocks(db, p.date, [...preserved, ...newBlocks]);
      const windowStart = [draft.window.start, ...preserved.map((b) => b.start)].filter(isValidTime).sort()[0] ?? draft.window.start;
      const windowEnd = [draft.window.end, ...preserved.map((b) => b.end)].filter(isValidTime).sort().pop() ?? draft.window.end;
      const final: PlanDraft = {
        ...draft,
        window: { start: windowStart, end: windowEnd },
        workBudgetMinutes: draft.workBudgetMinutes + (current ? preservedWork : 0),
        blocks,
      };
      const errors = validatePlanDraft(final, {
        meetings,
        tasks,
        notBefore: p.kind === "replan" ? fromMinutes(Math.max(0, nowMin - 10)) : null,
        preservedBlockIds: new Set(preserved.map((b) => b.id)),
      });
      if (errors.length) throw new UserFacingError("This plan doesn't pass the checks.", 422, "invalid_plan", errors);
      try {
        savePlanVersion(db, final, { expectedVersion: p.basePlanVersion, proposalId: p.id, source: opts.source });
      } catch (e) {
        if (e instanceof StalePlanError) throw new UserFacingError("Your plan changed meanwhile. Ask Nikki for an update.", 409, "stale");
        throw e;
      }
    }
    setProposalStatus(db, p.id, "confirmed");
    return { alreadyConfirmed: false };
  })();
}

export function discardProposal(db: DB, id: string) {
  const p = getProposal(db, id);
  if (!p) throw new UserFacingError("Proposal not found.", 404, "not_found");
  if (p.status === "pending") setProposalStatus(db, id, "discarded");
}

function applyTaskChange(db: DB, c: { taskId: string; change: string; title: string | null; estimateMinutes: number | null; deadline: string | null; notes: string | null }) {
  switch (c.change) {
    case "update": {
      const patch: Partial<Task> = {};
      if (c.title) patch.title = c.title;
      if (c.estimateMinutes) patch.estimateMinutes = c.estimateMinutes;
      if (c.deadline) patch.deadline = c.deadline;
      if (c.notes) patch.notes = c.notes;
      updateTask(db, c.taskId, patch);
      break;
    }
    case "complete":
      updateTask(db, c.taskId, { status: "done" });
      break;
    case "waiting":
      updateTask(db, c.taskId, { status: "waiting" });
      break;
    case "blocked":
      updateTask(db, c.taskId, { status: "blocked" });
      break;
    case "reopen":
      updateTask(db, c.taskId, { status: "open" });
      break;
    case "delete":
      deleteTask(db, c.taskId);
      break;
  }
}

/** Direct user edit of today's confirmed plan (move/extend/edit/remove blocks). */
export function editPlan(db: DB, input: { expectedVersion: number; plan: unknown }, timezone: string) {
  const now = localNow(timezone);
  const parsed = PlanDraftInput.safeParse(input.plan);
  if (!parsed.success) throw new UserFacingError("The edited plan is malformed.", 400, "invalid", parsed.error.issues.map((i) => i.message));
  const draft = normaliseDraft(now.date, parsed.data);
  const { meetings, blocks } = withMeetingBlocks(db, now.date, draft.blocks);
  const final = { ...draft, blocks };
  const errors = validatePlanDraft(final, { meetings, tasks: taskMap(db) });
  if (errors.length) throw new UserFacingError("That change doesn't fit the plan.", 422, "invalid_plan", errors);
  try {
    return savePlanVersion(db, final, { expectedVersion: input.expectedVersion, proposalId: null, source: "user-edit" });
  } catch (e) {
    if (e instanceof StalePlanError) {
      throw new UserFacingError("The plan was changed in another tab or by a newer proposal. Reloaded the latest version.", 409, "stale");
    }
    throw e;
  }
}

export function reviewNewDay(db: DB, decisions: { taskId: string; action: "keep" | "done" | "park" | "drop" }[], timezone: string) {
  const today = localNow(timezone).date;
  db.transaction(() => {
    for (const d of decisions) {
      if (d.action === "done") updateTask(db, d.taskId, { status: "done" });
      else if (d.action === "park") updateTask(db, d.taskId, { type: "idea", status: "open" });
      else if (d.action === "drop") deleteTask(db, d.taskId);
    }
    setSetting(db, "review_done", today);
  })();
}

const REPLACE_FIELDS = new Set(["name", "workStart", "workEnd", "timezone", "mainOutcome"]);

export function applyContextSuggestion(db: DB, proposalId: string, suggestionId: string, action: "save" | "dismiss", value?: string) {
  const p = getProposal(db, proposalId);
  const s = p?.contextSuggestions.find((c) => c.id === suggestionId);
  if (!p || !s) throw new UserFacingError("Suggestion not found.", 404, "not_found");
  if (s.status !== "pending") return;
  if (action === "save") {
    const v = (value ?? s.value).trim();
    if ((s.field === "workStart" || s.field === "workEnd") && !isValidTime(v)) throw new UserFacingError("Use HH:MM for working hours.");
    if (s.field === "timezone" && !isValidTimeZone(v)) throw new UserFacingError(`"${v}" isn't a recognised timezone.`);
    const profile = getProfile(db);
    const field = s.field as (typeof CONTEXT_FIELDS)[number];
    const cur = profile[field] ?? "";
    profile[field] = REPLACE_FIELDS.has(field) || !cur ? v : cur.includes(v) ? cur : `${cur}\n${v}`;
    saveProfile(db, profile);
  }
  s.status = action === "save" ? "saved" : "dismissed";
  saveProposal(db, p);
}

/** Tasks completed today (by local date), or done tasks that were in today's plan. */
export function doneToday(db: DB, timezone: string) {
  const today = localNow(timezone).date;
  const plan = currentPlan(db, today);
  const inPlan = new Set(plan?.blocks.map((b) => b.taskId).filter(Boolean) as string[]);
  return listTasks(db).filter(
    (t) => t.status === "done" && (inPlan.has(t.id) || (t.completedAt != null && localDateOf(t.completedAt, timezone) === today)),
  );
}

export type WrapDecision = { taskId: string; action: "tomorrow" | "done" | "park" | "drop" };

/** Evening wrap-up: applies decisions about unfinished work and saves a journal entry. No model call. */
export function wrapUpDay(db: DB, input: { decisions: WrapDecision[]; note: string }, timezone: string) {
  const today = localNow(timezone).date;
  return db.transaction(() => {
    for (const d of input.decisions) {
      if (d.action === "done") updateTask(db, d.taskId, { status: "done" });
      else if (d.action === "park") updateTask(db, d.taskId, { type: "idea", status: "open" });
      else if (d.action === "drop") deleteTask(db, d.taskId);
    }
    const done = doneToday(db, timezone);
    const tomorrow = input.decisions.filter((d) => d.action === "tomorrow").map((d) => d.taskId);
    const entry = saveWrapUp(db, {
      date: today,
      doneTaskIds: done.map((t) => t.id),
      doneTitles: done.map((t) => t.title),
      tomorrowTaskIds: tomorrow,
      note: input.note.trim(),
    });
    const parts = [
      `${done.length} done`,
      tomorrow.length ? `${tomorrow.length} moving to tomorrow` : "",
      input.decisions.filter((d) => d.action === "park").length ? `${input.decisions.filter((d) => d.action === "park").length} parked` : "",
      input.decisions.filter((d) => d.action === "drop").length ? `${input.decisions.filter((d) => d.action === "drop").length} dropped` : "",
    ].filter(Boolean);
    addMessage(db, { role: "assistant", text: `Day wrapped up: ${parts.join(", ")}.`, meta: { system: true, kind: "wrapup" } });
    return entry;
  })();
}
