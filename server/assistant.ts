import type {
  ChatMessage,
  Plan,
  MemoryUpdate,
  Project,
  ProjectDraft,
  WeeklyFacts,
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
  lastWrapUpBefore,
  wrapUpFor,
  listMeetingsBetween,
} from "./db.js";
import { estimationInsight } from "./learning.js";
import { declinedForModel, filterSuggestions } from "./contextMemory.js";
import { demoRespond } from "./demo.js";
import { buildAppState, boundedHistory, SYSTEM_PROMPT } from "./prompt.js";
import { getProvider } from "./provider/index.js";
import { ProviderError, ProviderMessage } from "./provider/types.js";
import { ModelResponse, RESPONSE_JSON_SCHEMA } from "./schema.js";
import { addDays, fromMinutes, weekdayOf, isValidDate, isValidTime, localNow, toMinutes } from "./time.js";
import { findDuplicate, freeMinutes, validateMeeting, validatePlanDraft } from "./validate.js";
import { UserFacingError } from "./errors.js";
import { ActionRequest, recordCreated, runActions } from "./commands.js";
import { markProvisional, pinnedToKeep } from "./planOps.js";
import { getProject, listProjects, projectViews, validateProjectDraft } from "./projects.js";
import { listMemory, memoryForModel, recentMinutesByProject, validateMemoryUpdates, weeklyFacts, weeklySummary } from "./memory.js";
import { activeReminders } from "./reminders.js";
import { buildFacts, computeTaskMeta, deadlinesThisWeek, suggestNext } from "./derived.js";
import type { Viewer } from "./timer.js";

export { UserFacingError } from "./errors.js";

export interface TurnInput {
  ws: Workspace;
  db: DB;
  text: string;
  kind: "chat" | "replan" | "review" | "wrapup" | "weekly_review";
  timezone: string;
  remainingUntil?: string | null;
  viewer?: Viewer;
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
  actions: ActionRequest[];
  projectPlan: ProjectDraft | null;
  memoryUpdates: MemoryUpdate[];
}

const MAX_CAPTURES = 25;

const emptyResponse = (): ModelResponse => ModelResponse.parse({ message: "", questions: [], captured_items: [], task_updates: [], meetings: [], context_updates: [], plan: null });

/** An estimate is only accepted if the user's own message gave a duration. */
const statedDuration = (text: string | undefined) =>
  text === undefined || /\b\d+(?:\.\d+)?\s*(?:m|min|mins|minutes?|h|hr|hrs|hours?)\b|\b(?:half an hour|an hour|a couple of hours|quarter of an hour)\b/i.test(text);

/** The app's own numbers, so Nikki reports them instead of working them out. */
function modelFacts(db: DB, tz: string, profile: ReturnType<typeof getProfile>, tasks: Task[], userText: string, weekly: WeeklyFacts | null) {
  const f = buildFacts(db, tz, profile);
  const meta = computeTaskMeta(tasks, f, new Map());
  const next = suggestNext(tasks, f, meta);
  const title = (id: string) => tasks.find((t) => t.id === id)?.title;
  const open = tasks.filter((t) => t.type === "action" && t.status !== "done");
  const atRisk = open.filter((t) => ["at_risk", "overdue"].includes(meta[t.id]?.deadlineStatus ?? "")).map((t) => ({ task_id: t.id, status: meta[t.id].deadlineStatus, short_by_minutes: meta[t.id].shortByMinutes ?? null }));
  const running = tasks.find((t) => t.timerStartedAt);
  return {
    ...(weekly ? { weekly } : {}),
    strategy: memoryForModel(listMemory(db, f.today), userText),
    projects: (() => {
      const all = projectViews(db, tasks, f.today);
      const recent = recentMinutesByProject(db, tz, tasks, 14);
      const live = all.filter((p) => p.status === "active" || p.status === "paused");
      return {
        active_and_paused: live.slice(0, 6).map((p) => ({
          id: p.id,
          title: p.title,
          goal: p.goal.slice(0, 160),
          status: p.status,
          target_date: p.targetDate,
          milestones: p.milestones.slice(0, 10).map((m) => ({ id: m.id, title: m.title, target: m.targetDate, status: m.status })),
          progress: { tasks_done: p.progress.tasksDone, tasks_total: p.progress.tasksTotal, milestones_done: p.progress.milestonesDone, milestones_total: p.progress.milestonesTotal, minutes_recorded: p.progress.workedMinutes, minutes_last_14_days: recent.get(p.id) ?? 0, unassigned_open_tasks: p.progress.unassigned },
          overdue_milestones: p.progress.overdueMilestoneIds,
          next_actions: p.progress.nextActionIds.map((id) => ({ task_id: id, title: tasks.find((t) => t.id === id)?.title })),
        })),
        other_projects: all.length - live.length,
      };
    })(),
    reminders: activeReminders(db, tz).slice(0, 15).map((r) => ({ id: r.id, title: r.title, when: `${r.localDate} ${r.localTime}`, status: r.status, ...(r.taskId ? { task_id: r.taskId } : {}) })),
    running_timer: running ? { task_id: running.id, title: running.title } : null,
    urgent_first: next ? { task_id: next.taskId, title: title(next.taskId), reason: next.reason } : null,
    at_risk_or_overdue: atRisk,
    deadlines_this_week: deadlinesThisWeek(tasks, f, meta),
    unfinished_today: open.filter((t) => t.plannedDate === f.today).map((t) => t.id),
    free_minutes_today_after_meetings: (() => {
      const w = f.windowFor(f.today);
      const from = Math.max(f.nowMin, toMinutes(w.start));
      const end = toMinutes(w.end);
      return end > from ? freeMinutes({ start: fromMinutes(from), end: fromMinutes(end) }, f.meetingsFor(f.today) as Meeting[]) : 0;
    })(),
  };
}

/**
 * Turns a (live or demo) model response into concrete, validated changes
 * WITHOUT writing anything. New tasks get their final ids up front so the plan
 * can reference them and be validated before anything is saved.
 */
export function resolveResponse(
  resp: ModelResponse,
  ctx: {
    tasks: Task[];
    /** Saved meetings on a given date. */
    meetingsOn: (date: string) => Meeting[];
    date: string;
    tomorrow: string;
    now: string;
    kind: TurnInput["kind"];
    source: Task["source"];
    /** A confirmed plan already exists for today, so a new one only replaces the rest of the day. */
    hasPlanToday?: boolean;
    /** The confirmed plan for a date, so pinned blocks can be protected. */
    planOn?: (date: string) => Plan | null;
    /** What the user typed, to check that an estimate was really stated by them. */
    userText?: string;
    memoryDb?: DB;
    projectOn?: (id: string) => Project | null;
    projectTitles?: string[];
  },
): Resolved {
  const notes: string[] = [];
  let planErrors: string[] = [];
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
      estimateMinutes: c.estimate_minutes && statedDuration(ctx.userText) ? c.estimate_minutes : null,
      deadline,
      projectId: null,
      milestoneId: null,
      deadlineTime: deadline && c.deadline_time && isValidTime(c.deadline_time) ? c.deadline_time : null,
      priority: c.priority,
      optional: c.optional,
      plannedDate: c.planned_date && isValidDate(c.planned_date) && c.planned_date >= ctx.date ? c.planned_date : null,
      project: c.project,
      createdAt: ts,
      updatedAt: ts,
      completedAt: null,
      source: ctx.source,
      actualMinutes: null,
      spentMinutes: 0,
      rolloverCount: 0,
      timerStartedAt: null,
      steps: [],
    };
    newTasks.push(t);
    refMap.set(c.ref, t.id);
  }

  const newMeetings: Meeting[] = [];
  for (const m of resp.meetings) {
    const date = m.date ?? ctx.date;
    if (!isValidDate(date) || date < ctx.date) {
      notes.push(`Didn't add "${m.title}": its date (${m.date}) isn't today or later.`);
      continue;
    }
    const all = [...ctx.meetingsOn(date), ...newMeetings.filter((x) => x.date === date)];
    if (all.some((e) => e.start === m.start && e.end === m.end)) continue;
    const errs = validateMeeting(m, all);
    if (errs.length) {
      notes.push(`Didn't add meeting: ${errs[0]}`);
      continue;
    }
    newMeetings.push({ id: newId("m"), date, title: m.title, start: m.start, end: m.end });
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
      plannedDate: u.planned_date && isValidDate(u.planned_date) && u.planned_date >= ctx.date ? u.planned_date : null,
      notes: u.notes,
      reason: u.reason,
    });
  }

  const contextSuggestions: ContextSuggestion[] = resp.context_updates
    .filter((c) => c.value.trim())
    .filter((c) => !["workStart", "workEnd"].includes(c.field) || isValidTime(c.value))
    .map((c) => ({ id: newId("cs"), field: c.field, action: c.action, value: c.value.trim(), reason: c.reason, status: "pending" }));

  let draft: PlanDraft | null = null;
  if (resp.plan && ctx.kind !== "wrapup") {
    const p = resp.plan;
    const resolve = (ref: string | null) => (ref ? (refMap.get(ref) ?? ref) : null);
    // Plans can be for today or tomorrow; replans are always for today.
    const planDate = ctx.kind !== "replan" && p.date === ctx.tomorrow ? ctx.tomorrow : ctx.date;
    if (p.date && p.date !== planDate) notes.push(`Nikki proposed a plan for ${p.date}; plans can only be made for today or tomorrow.`);
    const allMeetings = [...ctx.meetingsOn(planDate), ...newMeetings.filter((m) => m.date === planDate)];
    const nowMin = toMinutes(ctx.now);
    // Changing today's confirmed plan: the past is kept from that plan, so ignore copies of it.
    const editingToday = planDate === ctx.date && (ctx.kind === "replan" || !!ctx.hasPlanToday);
    const blocks: PlanBlock[] = [];
    for (const b of p.blocks) {
      if (editingToday && isValidTime(b.end) && toMinutes(b.end) <= nowMin) continue;
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
        ...(b.pinned && (b.kind === "focus" || b.kind === "task") ? { pinned: true } : {}),
      });
    }
    // Times the user fixed earlier are kept: put them back if the model left them out; overlaps become plan errors it must fix.
    const existing = ctx.planOn?.(planDate) ?? null;
    const byId0 = new Map([...ctx.tasks, ...newTasks].map((t) => [t.id, t]));
    const kept = pinnedToKeep(existing, planDate === ctx.date ? nowMin : -1, byId0, blocks);
    for (const keep of kept) blocks.push(keep);
    // Time the user fixed earlier is part of the day's work, not extra to the budget they gave.
    const keptMinutes = kept.reduce((a, b) => a + toMinutes(b.end) - toMinutes(b.start), 0);
    blocks.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    draft = {
      date: planDate,
      mainOutcome: p.main_outcome,
      focusTaskId: resolve(p.focus.task_ref),
      focusWhy: p.focus.why,
      supporting: p.supporting.map((s) => ({ taskId: resolve(s.task_ref)!, why: s.why })),
      deferred: p.deferred.map((s) => ({ taskId: resolve(s.task_ref)!, why: s.why })),
      reasons: p.reasons,
      assumptions: p.assumptions,
      window: p.window,
      workBudgetMinutes: p.work_budget_minutes + keptMinutes,
      blocks,
    };
    const taskMap = new Map([...ctx.tasks, ...newTasks].map((t) => [t.id, t]));
    draft.blocks = markProvisional(draft.blocks, taskMap);
    planErrors = validatePlanDraft(draft, {
      meetings: allMeetings,
      tasks: taskMap,
      // A few minutes' grace: "2:30" said at 2:31 should still mean 2:30.
      notBefore: editingToday ? fromMinutes(Math.max(0, toMinutes(ctx.now) - 10)) : null,
    });
    // Tasks already done shouldn't be scheduled again.
    for (const b of blocks) {
      const t = b.taskId ? taskMap.get(b.taskId) : null;
      if (t?.status === "done") planErrors.push(`"${t.title}" is already completed and shouldn't be scheduled.`);
    }
  }
  // A project proposal: validated here, saved only if the user confirms. Estimates must have been stated by the user.
  let projectPlan: ProjectDraft | null = null;
  if (resp.project_plan) {
    const pp = resp.project_plan;
    const dateOk = (d: string | null) => (d && isValidDate(d) ? d : d ? d : null);
    projectPlan = {
      projectId: pp.project_id,
      title: pp.title.trim(),
      goal: pp.goal ?? "",
      targetDate: dateOk(pp.target_date),
      assumptions: pp.assumptions,
      dependencies: pp.dependencies,
      milestones: pp.milestones.map((m) => ({ id: m.id, ref: m.ref, title: m.title.trim(), targetDate: dateOk(m.target_date), remove: m.remove })),
      tasks: pp.tasks.map((t) => ({ ref: t.ref, title: t.title.trim(), milestoneRef: t.milestone_ref, priority: t.priority, estimateMinutes: t.estimate_minutes && statedDuration(ctx.userText) ? t.estimate_minutes : null })),
      reason: pp.reason,
    };
    const existing = projectPlan.projectId ? (ctx.projectOn?.(projectPlan.projectId) ?? null) : null;
    for (const e of validateProjectDraft(projectPlan, { today: ctx.date, existing })) planErrors.push(`Project plan: ${e}`);
    // Don't duplicate an existing project when the model proposes it as new.
    if (!projectPlan.projectId && ctx.projectTitles?.some((t) => t.toLowerCase() === projectPlan!.title.toLowerCase())) {
      planErrors.push(`Project plan: a project called "${projectPlan.title}" already exists — revise it with its project_id instead of creating another.`);
    }
  }
  // Changes to what Nikki remembers are proposals too. Tentative things can't be stored as firm facts by the model alone.
  const memoryUpdates: MemoryUpdate[] = resp.memory_updates
    .filter((m) => m.op !== "add" || m.text.trim())
    .map((m) => ({
      id: newId("mu"),
      op: m.op,
      itemId: m.item_id,
      kind: m.kind,
      text: m.text.trim(),
      status: m.status,
      rationale: m.rationale,
      projectId: m.project_id,
      reviewAfter: m.review_after,
      reason: m.reason,
    }));
  if (memoryUpdates.length) for (const e of validateMemoryUpdates(memoryUpdates, ctx.memoryDb!, ctx.date)) planErrors.push(`Memory: ${e}`);
  const actions = resp.actions.map((a) => ({ ...a, task_id: refMap.get(a.task_id) ?? a.task_id }));
  return { newTasks, newMeetings, draft, planErrors, taskChanges, contextSuggestions, notes, refMap, actions, projectPlan, memoryUpdates };
}

function parseModelJson(text: string): { ok: true; value: ModelResponse } | { ok: false; errors: string[] } {
  let json: unknown;
  // Tolerate code fences or stray text around the object (non-structured fallback mode).
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? text.slice(first, last + 1) : text;
  try {
    json = JSON.parse(candidate);
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
    const ctx = {
      tasks,
      meetingsOn: (date: string) => (date === now.date ? meetings : listMeetings(db, date)),
      date: now.date,
      tomorrow: addDays(now.date, 1),
      now: now.time,
      kind: input.kind,
      source: ws === "demo" ? ("demo" as const) : ("nikki" as const),
      hasPlanToday: !!plan,
      planOn: (date: string) => currentPlan(db, date),
      userText: input.text,
      memoryDb: db,
      projectOn: (id: string) => getProject(db, id),
      projectTitles: listProjects(db).map((p) => p.title),
    };

    let resp: ModelResponse;
    let resolved: Resolved;
    let demoMeta: Record<string, unknown> = {};
    const weekly = input.kind === "weekly_review" ? weeklyFacts(db, input.timezone, tasks) : null;

    if (!provider && weekly) {
      // Demo mode has no model: the review is a plain summary of the app's own counts.
      resp = { ...emptyResponse(), message: weeklySummary(weekly) };
      demoMeta = { demo: true };
      resolved = resolveResponse(resp, ctx);
    } else if (!provider) {
      const lastAssistant = [...history].reverse().find((m) => m.role === "assistant" && !m.meta.system) ?? null;
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
        learning: estimationInsight(tasks),
        tomorrow: { date: ctx.tomorrow, meetings: listMeetings(db, ctx.tomorrow) },
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
        learning: estimationInsight(tasks),
        lastWrapUp: lastWrapUpBefore(db, now.date),
        wrapUpToday: wrapUpFor(db, now.date),
        tomorrow: {
          date: ctx.tomorrow,
          weekday: weekdayOf(ctx.tomorrow),
          plan: currentPlan(db, ctx.tomorrow),
          meetings: listMeetings(db, ctx.tomorrow),
        },
        upcoming: listMeetingsBetween(db, addDays(now.date, 2), addDays(now.date, 30)),
        declinedSuggestions: declinedForModel(db),
        facts: modelFacts(db, input.timezone, profile, tasks, input.text, weekly),
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
          message: `${resp.message}\n\nI couldn't produce a plan that passes the app's checks (${resolved.planErrors[0]}). Could you tell me more about your available time, or should I try again?`,
        };
        resolved.draft = null;
        resolved.projectPlan = null;
        resolved.memoryUpdates = [];
      }
    }

    return persistTurn(db, { resp, resolved, demoMeta, weekly, pending, baseVersion, date: now.date, kind: input.kind, tz: input.timezone, viewer: input.viewer ?? { clientId: null, prevSeenAt: null } });
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
    weekly: WeeklyFacts | null;
    pending: Proposal | null;
    baseVersion: number;
    date: string;
    kind: TurnInput["kind"];
    tz: string;
    viewer: Viewer;
  },
) {
  return db.transaction(() => {
    const { resolved, resp } = a;
    for (const t of resolved.newTasks) createTask(db, t);
    for (const m of resolved.newMeetings) createMeeting(db, m);
    // The app runs the requested actions itself; the receipts, not the model's wording, are the record.
    const receipts = runActions(db, resolved.actions, { tz: a.tz, viewer: a.viewer });
    const createdUndo = recordCreated(db, resolved.newTasks.map((t) => t.id));
    if (createdUndo) {
      receipts.unshift({
        ok: true,
        text: resolved.newTasks.length === 1 ? `Added “${resolved.newTasks[0].title}”.` : `Added ${resolved.newTasks.length} tasks.`,
        undoId: createdUndo,
      });
    }
    let proposal: Proposal | null = null;
    let draft = resolved.draft;
    if (
      !draft &&
      a.pending?.plan &&
      a.pending.date >= a.date &&
      a.pending.basePlanVersion === currentPlanVersion(db, a.pending.date)
    ) {
      draft = a.pending.plan; // carry an unconfirmed plan forward while clarifying
    }
    // Newer suggestions win; carried-over pending ones are kept only for other fields.
    const carried = (a.pending?.contextSuggestions ?? []).filter((c) => c.status === "pending");
    resolved.contextSuggestions = filterSuggestions(db, getProfile(db), [...carried, ...resolved.contextSuggestions]);
    if (draft || resolved.projectPlan || resolved.memoryUpdates.length || resolved.taskChanges.length || resolved.contextSuggestions.length) {
      supersedePending(db);
      proposal = {
        id: newId("pr"),
        createdAt: nowIso(),
        status: "pending",
        date: draft?.date ?? a.date,
        kind: a.kind === "replan" ? "replan" : "plan",
        basePlanVersion: draft ? currentPlanVersion(db, draft.date) : a.baseVersion,
        plan: draft,
        taskChanges: resolved.taskChanges,
        contextSuggestions: resolved.contextSuggestions,
        warnings: resolved.notes,
        projectPlan: resolved.projectPlan,
        memoryUpdates: resolved.memoryUpdates,
      };
      saveProposal(db, proposal);
    }
    const message = addMessage(db, {
      role: "assistant",
      text:
        resp.message.trim() ||
        (resp.questions.length ? "A couple of quick questions:" : proposal ? "Here's the change. Tap Confirm to apply it." : "Got it."),
      meta: {
        ...a.demoMeta,
        kind: a.kind,
        questions: resp.questions.slice(0, 2),
        quickReplies: resp.quick_replies.map((q) => q.trim()).filter(Boolean).slice(0, 3),
        proposalId: proposal?.id,
        capturedTaskIds: resolved.newTasks.map((t) => t.id),
        addedMeetingIds: resolved.newMeetings.map((m) => m.id),
        notes: resolved.notes.length ? resolved.notes : undefined,
        receipts: receipts.length ? receipts : undefined,
        weekly: a.weekly ?? undefined,
      },
    });
    return { message, proposal };
  })();
}
