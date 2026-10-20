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
  listMeetingsBetween,
  wrapUpFor,
  lastWrapUpBefore,
  saveWrapUp,
  addMessage,
  getTask,
} from "./db.js";
import { freeSegments } from "./scheduler.js";
import { getProvider } from "./provider/index.js";
import { estimationInsight } from "./learning.js";
import { feedInfo } from "./calendar.js";
import { getFeedToken } from "./icsExport.js";
import { LIST_FIELDS, recordDecision } from "./contextMemory.js";
import { addDays, fromMinutes, isValidTimeZone, isValidTime, localDateOf, localNow, toMinutes, weekdayOf } from "./time.js";
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
  if (proposal && proposal.date < now.date && proposal.plan) proposal = { ...proposal, status: "stale" };

  // Unfinished work from earlier days: tasks in the last plan (unless a wrap-up already decided)
  // and open actions whose planned day has passed. Shown once a day until reviewed.
  let newDay: AppState["newDay"] = null;
  if (getSetting(db, "review_done") !== now.date) {
    const ids = new Set<string>();
    const last = latestPlanBefore(db, now.date);
    if (last && !wrapUpFor(db, last.date)) {
      for (const b of last.blocks) if (b.taskId && WORK_KINDS.has(b.kind)) ids.add(b.taskId);
      if (last.focusTaskId) ids.add(last.focusTaskId);
      last.supporting.forEach((s) => ids.add(s.taskId));
    }
    for (const t of tasks) if (t.type === "action" && t.plannedDate && t.plannedDate < now.date) ids.add(t.id);
    const inTodayPlan = new Set(plan?.blocks.map((b) => b.taskId).filter(Boolean) as string[]);
    const unfinished = tasks
      .filter((t) => ids.has(t.id) && t.status !== "done" && !inTodayPlan.has(t.id) && !(t.plannedDate && t.plannedDate >= now.date))
      .map((t) => t.id);
    if (unfinished.length) newDay = { lastPlanDate: last?.date ?? addDays(now.date, -1), unfinishedTaskIds: unfinished };
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
    tomorrow: (() => {
      const date = addDays(now.date, 1);
      return { date, weekday: weekdayOf(date), plan: currentPlan(db, date), meetings: listMeetings(db, date) };
    })(),
    upcoming: listMeetingsBetween(db, addDays(now.date, 1), addDays(now.date, 30)),
    calendars: feedInfo(db),
    nikkiFeedToken: getFeedToken(db) || null,
    hasAnyData: messages.length > 0 || tasks.length > 0 || !!profile.updatedAt || feedInfo(db).length > 0,
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
  if (p.plan && (p.date < now.date || p.date > addDays(now.date, 1))) {
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
      applyTaskChange(db, c, { today: now.date, skipPlanDate: p.plan?.date ?? null });
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
      // For tomorrow's plan nothing is in the past yet.
      const nowMin = p.date === now.date ? toMinutes(now.time) : -1;
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

function applyTaskChange(
  db: DB,
  c: { taskId: string; change: string; title: string | null; estimateMinutes: number | null; deadline: string | null; plannedDate?: string | null; notes: string | null },
  days: { today: string; skipPlanDate: string | null },
) {
  const tomorrow = addDays(days.today, 1);
  // Keep confirmed plans in step with the change. The plan being confirmed in the same step is replaced anyway.
  const takeOff = (dates: string[], why: string) => {
    for (const d of dates) if (d !== days.skipPlanDate) removeTaskFromPlan(db, d, c.taskId, why);
  };
  switch (c.change) {
    case "update": {
      const patch: Partial<Task> = {};
      if (c.title) patch.title = c.title;
      if (c.estimateMinutes) patch.estimateMinutes = c.estimateMinutes;
      if (c.deadline) patch.deadline = c.deadline;
      if (c.plannedDate) patch.plannedDate = c.plannedDate;
      if (c.notes) patch.notes = c.notes;
      updateTask(db, c.taskId, patch);
      if (c.plannedDate) takeOff([days.today, tomorrow].filter((d) => d !== c.plannedDate), `Moved to ${c.plannedDate}.`);
      break;
    }
    case "unschedule":
      updateTask(db, c.taskId, { plannedDate: c.plannedDate && c.plannedDate > days.today ? c.plannedDate : null });
      takeOff([days.today], "You took this off today.");
      break;
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
      takeOff([days.today, tomorrow], "Deleted.");
      break;
  }
}

/**
 * Takes a task off a day's confirmed plan: its blocks, focus and supporting slots.
 * The work budget shrinks by the removed time so the numbers keep adding up.
 */
export function removeTaskFromPlan(db: DB, date: string, taskId: string, why: string): boolean {
  const plan = currentPlan(db, date);
  if (!plan) return false;
  const inPlan = plan.blocks.some((b) => b.taskId === taskId) || plan.focusTaskId === taskId || plan.supporting.some((s) => s.taskId === taskId);
  if (!inPlan) return false;
  const { id: _i, version, status: _s, createdAt: _c, proposalId: _p, source: _so, ...draft } = plan;
  const removed = draft.blocks.filter((b) => b.taskId === taskId && WORK_KINDS.has(b.kind)).reduce((s, b) => s + toMinutes(b.end) - toMinutes(b.start), 0);
  const stillExists = !!getTask(db, taskId);
  savePlanVersion(
    db,
    {
      ...draft,
      focusTaskId: draft.focusTaskId === taskId ? null : draft.focusTaskId,
      supporting: draft.supporting.filter((s) => s.taskId !== taskId),
      deferred: [...draft.deferred.filter((s) => s.taskId !== taskId), ...(stillExists ? [{ taskId, why }] : [])],
      blocks: draft.blocks.filter((b) => b.taskId !== taskId),
      workBudgetMinutes: Math.max(0, draft.workBudgetMinutes - removed),
    },
    { expectedVersion: version, proposalId: null, source: "user-edit" },
  );
  return true;
}

export type RescheduleInput = { to: "later_today" } | { to: "date"; date: string } | { to: "someday" };

/**
 * Direct user action for work that didn't get done: fit it into a free gap later today,
 * move it to another day, or take it off the calendar ("someday"). Applies immediately.
 */
export function rescheduleTask(db: DB, taskId: string, input: RescheduleInput, timezone: string) {
  const task = getTask(db, taskId);
  if (!task) throw new UserFacingError("Task not found.", 404, "not_found");
  const now = localNow(timezone);
  return db.transaction(() => {
    if (input.to === "later_today") {
      const plan = currentPlan(db, now.date);
      if (!plan) throw new UserFacingError("There's no plan for today to fit it into. Ask Nikki to plan today.");
      // Only the part whose time has passed moves; anything still coming up stays where it is.
      const nowMin = toMinutes(now.time);
      const own = plan.blocks.filter((b) => b.taskId === taskId && WORK_KINDS.has(b.kind));
      const missed = own.filter((b) => toMinutes(b.end) <= nowMin);
      const missedMinutes = missed.reduce((s, b) => s + toMinutes(b.end) - toMinutes(b.start), 0);
      if (own.length && !missed.length) return { message: `“${task.title}” is already coming up later today.` };
      const need = Math.max(15, Math.min(240, missedMinutes || task.estimateMinutes || 30));
      const others = plan.blocks.filter((b) => !missed.includes(b));
      const from = Math.max(toMinutes(plan.window.start), Math.ceil(toMinutes(now.time) / 5) * 5);
      const busy = others.map((b) => ({ start: b.start, end: b.end })).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
      // Fill the next free gaps (at least 15 minutes each) until the missed time fits.
      const pieces: [number, number][] = [];
      let left = need;
      for (const [s, e] of freeSegments(from, toMinutes(plan.window.end), busy)) {
        if (left <= 0) break;
        if (e - s < 15) continue;
        const take = Math.min(left, e - s);
        pieces.push([s, s + take]);
        left -= take;
      }
      if (left > 0) {
        throw new UserFacingError(
          `There isn't ${need} minutes free in the rest of today's plan. Move it to tomorrow, or ask Nikki to rework the day.`,
          422,
          "no_room",
        );
      }
      const { id: _i, version, status: _s, createdAt: _c, proposalId: _p, source: _so, ...draft } = plan;
      const kind = own.some((b) => b.kind === "focus") ? "focus" : "task";
      const added: PlanBlock[] = pieces.map(([s, e]) => ({
        id: newId("b"),
        start: fromMinutes(s),
        end: fromMinutes(e),
        kind,
        taskId,
        meetingId: null,
        title: task.title,
      }));
      const blocks = sortBlocks([...others, ...added]);
      const work = blocks.filter((b) => WORK_KINDS.has(b.kind)).reduce((s, b) => s + toMinutes(b.end) - toMinutes(b.start), 0);
      const final: PlanDraft = {
        ...draft,
        blocks,
        deferred: draft.deferred.filter((d) => d.taskId !== taskId),
        workBudgetMinutes: Math.max(draft.workBudgetMinutes, work),
      };
      const { meetings } = withMeetingBlocks(db, now.date, blocks);
      const errors = validatePlanDraft(final, { meetings, tasks: taskMap(db) });
      if (errors.length) throw new UserFacingError("That doesn't fit today's plan.", 422, "invalid_plan", errors);
      savePlanVersion(db, final, { expectedVersion: version, proposalId: null, source: "user-edit" });
      updateTask(db, taskId, { plannedDate: now.date, status: task.status === "done" ? "done" : "open" });
      return { message: `Moved “${task.title}” to ${added[0].start}.` };
    }
    if (input.to === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || input.date < now.date) throw new UserFacingError("Pick today or a later date.");
      const wasDue = task.plannedDate != null && task.plannedDate <= now.date;
      const inTodayPlan = !!currentPlan(db, now.date)?.blocks.some((b) => b.taskId === taskId);
      if (input.date !== now.date) removeTaskFromPlan(db, now.date, taskId, `Moved to ${input.date}.`);
      const tomorrow = addDays(now.date, 1);
      if (input.date !== tomorrow) removeTaskFromPlan(db, tomorrow, taskId, `Moved to ${input.date}.`);
      const slipped = input.date > now.date && (wasDue || inTodayPlan);
      updateTask(db, taskId, {
        plannedDate: input.date,
        status: task.status === "done" ? "done" : "open",
        rolloverCount: task.rolloverCount + (slipped ? 1 : 0),
      });
      return { message: input.date === now.date ? `“${task.title}” is on for today.` : `Moved “${task.title}” to ${input.date}.` };
    }
    removeTaskFromPlan(db, now.date, taskId, "Moved to someday.");
    removeTaskFromPlan(db, addDays(now.date, 1), taskId, "Moved to someday.");
    updateTask(db, taskId, { plannedDate: null });
    return { message: `“${task.title}” is off the calendar. It stays in Everything.` };
  })();
}

/** Direct user edit of today's confirmed plan (move/extend/edit/remove blocks). */
export function editPlan(db: DB, input: { expectedVersion: number; plan: unknown; date?: string }, timezone: string) {
  const now = localNow(timezone);
  const parsed = PlanDraftInput.safeParse(input.plan);
  if (!parsed.success) throw new UserFacingError("The edited plan is malformed.", 400, "invalid", parsed.error.issues.map((i) => i.message));
  const date = input.date === addDays(now.date, 1) ? input.date : now.date;
  const draft = normaliseDraft(date, parsed.data);
  const { meetings, blocks } = withMeetingBlocks(db, date, draft.blocks);
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

export type ReviewAction = "today" | "tomorrow" | "done" | "someday" | "drop";

/** Morning review of unfinished work. Direct user decisions, applied immediately. */
export function reviewNewDay(db: DB, decisions: { taskId: string; action: ReviewAction }[], timezone: string) {
  const today = localNow(timezone).date;
  db.transaction(() => {
    for (const d of decisions) {
      const t = getTask(db, d.taskId);
      if (!t) continue;
      if (d.action === "done") updateTask(db, d.taskId, { status: "done" });
      else if (d.action === "today") updateTask(db, d.taskId, { plannedDate: today, status: "open", rolloverCount: t.rolloverCount + 1 });
      else if (d.action === "tomorrow") rescheduleTask(db, d.taskId, { to: "date", date: addDays(today, 1) }, timezone);
      else if (d.action === "someday") rescheduleTask(db, d.taskId, { to: "someday" }, timezone);
      else if (d.action === "drop") deleteTaskEverywhere(db, d.taskId, today);
    }
    setSetting(db, "review_done", today);
  })();
}

/** Deletes a task and takes it off today's and tomorrow's plans. */
export function deleteTaskEverywhere(db: DB, taskId: string, today: string) {
  deleteTask(db, taskId);
  removeTaskFromPlan(db, today, taskId, "Deleted.");
  removeTaskFromPlan(db, addDays(today, 1), taskId, "Deleted.");
}


export function applyContextSuggestion(db: DB, proposalId: string, suggestionId: string, action: "save" | "dismiss", value?: string) {
  const p = getProposal(db, proposalId);
  const s = p?.contextSuggestions.find((c) => c.id === suggestionId);
  if (!p || !s) throw new UserFacingError("Suggestion not found.", 404, "not_found");
  if (s.status !== "pending") return;
  if (action === "save") {
    const v = (value ?? s.value).trim();
    if (s.action !== "remove" && (s.field === "workStart" || s.field === "workEnd") && !isValidTime(v)) throw new UserFacingError("Use HH:MM for working hours.");
    if (s.action !== "remove" && s.field === "timezone" && !isValidTimeZone(v)) throw new UserFacingError(`"${v}" isn't a recognised timezone.`);
    const profile = getProfile(db);
    const field = s.field as (typeof CONTEXT_FIELDS)[number];
    const cur = (profile[field] ?? "").trim();
    if (s.action === "remove") {
      // Remove exactly the line the user saw.
      profile[field] = LIST_FIELDS.has(field)
        ? cur
            .split("\n")
            .filter((l) => l.trim() !== s.value.trim())
            .join("\n")
        : "";
    } else {
      // List fields: add the new line (existing lines are kept). Single values: replace.
      profile[field] = LIST_FIELDS.has(field) && cur ? `${cur}\n${v}` : v;
    }
    saveProfile(db, profile);
  }
  s.status = action === "save" ? "saved" : "dismissed";
  recordDecision(db, s.field, s.action === "remove" ? `remove:${s.value}` : s.value, s.status);
  // A card that only held suggestions is finished once every suggestion is answered.
  if (!p.plan && !p.taskChanges.length && p.contextSuggestions.every((c) => c.status !== "pending")) p.status = "confirmed";
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

export type WrapDecision = { taskId: string; action: "tomorrow" | "done" | "someday" | "drop" };

/** Evening wrap-up: applies decisions about unfinished work and saves a journal entry. No model call. */
export function wrapUpDay(db: DB, input: { decisions: WrapDecision[]; note: string }, timezone: string) {
  const today = localNow(timezone).date;
  return db.transaction(() => {
    for (const d of input.decisions) {
      if (!getTask(db, d.taskId)) continue;
      if (d.action === "done") updateTask(db, d.taskId, { status: "done" });
      else if (d.action === "tomorrow") rescheduleTask(db, d.taskId, { to: "date", date: addDays(today, 1) }, timezone);
      else if (d.action === "someday") rescheduleTask(db, d.taskId, { to: "someday" }, timezone);
      else if (d.action === "drop") deleteTaskEverywhere(db, d.taskId, today);
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
      input.decisions.filter((d) => d.action === "someday").length ? `${input.decisions.filter((d) => d.action === "someday").length} for someday` : "",
      input.decisions.filter((d) => d.action === "drop").length ? `${input.decisions.filter((d) => d.action === "drop").length} dropped` : "",
    ].filter(Boolean);
    addMessage(db, { role: "assistant", text: `Day wrapped up: ${parts.join(", ")}.`, meta: { system: true, kind: "wrapup" } });
    return entry;
  })();
}

/** After commitments change, rebuild a day's plan meeting blocks if the plan still fits. Returns a warning if it doesn't. */
export function rebuildPlanMeetings(db: DB, date: string, today: string): string | null {
  const plan = currentPlan(db, date);
  if (!plan) return null;
  const meetings = listMeetings(db, date);
  const same =
    JSON.stringify(plan.blocks.filter((b) => b.kind === "meeting").map((b) => [b.meetingId, b.start, b.end])) ===
    JSON.stringify(meetings.map((m) => [m.id, m.start, m.end]));
  if (same) return null;
  const { meetings: ms, blocks } = withMeetingBlocks(db, date, plan.blocks);
  const { id: _i, version, status: _s, createdAt: _c, proposalId: _p, source: _so, ...rest } = plan;
  const draft = { ...rest, blocks };
  const errors = validatePlanDraft(draft, { meetings: ms, tasks: taskMap(db) });
  if (errors.length) {
    return `Your ${date === today ? "today" : "tomorrow"} plan clashes with a changed meeting (${errors[0]}). Ask Nikki to update the plan.`;
  }
  savePlanVersion(db, draft, { expectedVersion: version, proposalId: null, source: "user-edit" });
  return null;
}
