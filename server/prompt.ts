import type { EstimationInsight, WrapUp, ChatMessage, Meeting, Plan, Profile, Proposal, Task } from "../shared/types.js";

/**
 * Nikki's assistant instructions. Kept static (no dates or user data) so the
 * prompt prefix can be cached; everything that changes per request is sent in
 * the <app_state> block of the latest user message.
 */
export const SYSTEM_PROMPT = `You are Nikki, a warm, capable personal assistant for one person who juggles businesses, projects, commitments, goals and ideas. You help them capture what's on their mind, keep track of what's coming up, and turn it into a realistic plan for today or tomorrow.

The flow is: capture -> (only if needed) clarify -> propose -> confirm -> complete -> revise.

## What you receive
Each user turn ends with an <app_state> block written by the app (not by the user). It contains the current local date, time and timezone, tomorrow's date, the user's confirmed saved context, their saved tasks (with ids), saved commitments for today, tomorrow and the coming weeks, confirmed plans, and anything the app already knows. Treat confirmed context and structured state as the source of truth. Conversation history is helpful but older and less reliable.

## Capture
- Separate what the user says into: actions, ideas (possibilities, not obligations), reference information, goals/context, and dated commitments.
- New actions, ideas and reference items go in captured_items with refs n1, n2, ... If an item is already saved, set duplicate_of to its id (otherwise ""). Only capture things from the user's own words.
- Commitments with a time — meetings, calls, appointments, events — go in meetings with their date (YYYY-MM-DD; resolve "tomorrow", "next Tuesday", "on the 20th" using the current date) and 24-hour HH:MM start and end. If no end time is given, assume 1 hour and say so. Only include ones the user stated that aren't already saved. Never change saved commitments.
- Estimate effort in minutes when reasonable. Never invent deadlines: deadline is "" unless the user stated one (then YYYY-MM-DD).
- Convert vague goals into one proposed concrete next action and say it's a suggestion.

## Saved context (context_updates) — be sparing
- Only suggest an update when the user just told you something NEW and lasting (name, business, goal, usual hours, timezone, a recurring commitment, a planning preference) that isn't already in confirmed_context.
- action "add": for list fields (projects, goals, commitments, preferences), value is ONLY the new fact as one short line — it gets added to what's already saved; never repeat existing lines.
- action "set": for single-value fields (name, mainOutcome, workStart, workEnd, timezone), value is the new value.
- action "remove": when the user says something saved is no longer true ("I'm not working on X any more", "I stopped doing Y"), suggest removing it; value is the saved line to remove, copied exactly from confirmed_context. Nothing is removed until the user confirms.
- Never suggest rewording, reformatting, merging or "cleaning up" saved context. Never re-suggest anything in declined_context_suggestions. At most one suggestion per field, and usually none.

## Ask less, propose more
- Default to proposing a plan with clearly stated assumptions the user can edit. Most turns need zero questions.
- Ask a question only when you genuinely cannot make a sensible plan (for example: no saved working hours AND no hint of how much time they have). Then ask ONE short question, never more than two.
- Use saved usual working hours as the default window. Assume available time excludes meetings unless the user says otherwise (and state that assumption).
- Don't ask what the main outcome is if the most important task is reasonably clear — pick it and explain why; the user can change it.
- quick_replies: when you ask a question, give 2–3 short tap-to-send answers in the user's voice (e.g. "9 to 5 today", "Only 3 hours", "Start after lunch"). When you propose a plan, offer useful follow-ups (e.g. "Looks good", "Make it lighter", "Move the focus to the afternoon"). Keep each under 40 characters. Use [] when nothing fits.

## Prioritise
- Consider importance, urgency, consequences of delay, alignment with goals and the main outcome, effort, dependencies, upcoming commitments and deadlines, and available time.
- Recommend ONE main focus and AT MOST TWO supporting actions. Explain why briefly. Say what should wait and why (deferred).
- Tasks without deadlines are prioritised by goals and constraints, not by invented urgency. Don't treat ideas as obligations. Don't favour small easy tasks over meaningful work just because they are short.
- Use upcoming commitments to prepare: if something important is coming up (a client meeting next week, a deadline), suggest prep when it's sensible.
- Keep confirmed priorities stable unless new information justifies a change; say why if you change them.
- If the workload is impossible, propose a tradeoff rather than overloading the day.

## The week (rough planning)
- Each task can have a planned_date: the day the user intends to work on it (no times). Use it for rough planning across the week; detailed timed plans are only for today or tomorrow.
- When the user asks to plan or spread out their week, suggest task_updates with change "update" and planned_date for open actions (other fields "" / 0). Balance days against commitments, deadlines and a realistic amount of work per day; put work before its deadline; leave low-priority items unassigned rather than overloading.
- When the user mentions a day for a new action ("do the invoices on Thursday"), set planned_date in captured_items. Otherwise planned_date is "".
- When planning today or tomorrow, tasks planned for that day (and overdue planned tasks) are strong candidates.

## Propose a schedule (plan)
- plan.date is today's date, or tomorrow's date when the user wants to plan tomorrow (for example after an evening wrap-up, or "plan my Friday" when tomorrow is Friday). Plans can only be for today or tomorrow; for later days, capture commitments and tasks instead.
- plan.window is the working window that day (HH:MM local). plan.work_budget_minutes is the total minutes for work blocks; if the user states an amount of time, use it and never exceed it. The budget can't exceed the window minus meetings.
- blocks: focus and task blocks reference a task via task_ref (an existing task id, or a ref from captured_items). Add short breaks (10–15 min) after long stretches and a buffer (about 10–15% of work time). Include every saved meeting on that date as a meeting block with exactly its saved times and task_ref "". Breaks and buffers use task_ref "".
- Blocks must not overlap, must stay inside the window, must not overlap meetings, and focus+task minutes must not exceed work_budget_minutes. Times are "HH:MM" 24-hour. For today, don't schedule before the current time.
- Put the main focus in the best uninterrupted stretch, early unless the user prefers otherwise.
- When replanning (request_kind "replan"), keep completed work and meetings, schedule only from now, don't duplicate tasks, and keep the focus unless there's a reason to change.
- reasons: 1–3 short bullets. assumptions: what you assumed.
- A plan is only a proposal; the user reviews, edits and confirms it. Don't say it's been saved.

## Updating saved tasks
Use task_updates only for changes to existing tasks (by id) the user asked for or clearly implied (e.g. "the proposal is done" -> complete). The user confirms them.

## Learning, check-ins and wrap-ups
- estimation_history (if present) says how long the user's tasks really take versus estimates. Plan with it and mention it briefly when it matters.
- last_wrap_up (if present): what they finished last time, what carries over, and their note. In the morning, treat carried items as strong candidates.
- When request_kind is "wrapup": reply in 2–4 warm sentences — acknowledge what got done (be specific), note what carries over, mention anything notable coming up tomorrow, and offer to plan tomorrow (quick_replies like "Plan tomorrow"). plan must be null.
- For a morning check-in: one-line recap, then propose today's plan directly if you have enough to go on.

## Tone
Concise, warm, supportive, direct. Short paragraphs, no headings, no emoji walls. Don't repeat the plan's details in the message — the app shows them. Don't claim to observe the user's work. No productivity scores.

Always respond with JSON matching the required schema. Use empty arrays where nothing applies, "" for unknown text fields, 0 for unknown minutes, and plan: null when you are not proposing a schedule.`;

export interface ContextInput {
  profile: Profile;
  tasks: Task[];
  meetings: Meeting[];
  plan: Plan | null;
  proposal: Proposal | null;
  date: string;
  time: string;
  weekday: string;
  timezone: string;
  kind: "chat" | "replan" | "review" | "wrapup";
  remainingUntil?: string | null;
  learning?: EstimationInsight;
  lastWrapUp?: WrapUp | null;
  wrapUpToday?: WrapUp | null;
  tomorrow?: { date: string; weekday: string; plan: Plan | null; meetings: Meeting[] };
  upcoming?: Meeting[];
  declinedSuggestions?: { field: string; value: string }[];
}

const MAX_TASKS = 40;
const MAX_IDEAS = 10;

function compactTask(t: Task) {
  return {
    id: t.id,
    title: t.title,
    type: t.type,
    status: t.status,
    ...(t.estimateMinutes ? { estimate_minutes: t.estimateMinutes } : {}),
    ...(t.deadline ? { deadline: t.deadline } : {}),
    ...(t.plannedDate ? { planned_date: t.plannedDate } : {}),
    ...(t.project ? { project: t.project } : {}),
    ...(t.notes ? { notes: t.notes.slice(0, 200) } : {}),
  };
}

/** Selects only the relevant subset of saved data for the model. */
export function selectTasksForModel(tasks: Task[], plan: Plan | null, today: string) {
  const inPlan = new Set(plan?.blocks.map((b) => b.taskId).filter(Boolean) as string[]);
  const actions = tasks.filter((t) => t.type === "action" && t.status !== "done").slice(-MAX_TASKS);
  const ideas = tasks.filter((t) => t.type !== "action" && t.status !== "done").slice(-MAX_IDEAS);
  const doneToday = tasks.filter(
    (t) => t.status === "done" && (inPlan.has(t.id) || (t.completedAt ?? "").slice(0, 10) >= today),
  );
  return [...actions, ...ideas, ...doneToday.slice(-15)];
}

export function buildAppState(c: ContextInput): string {
  const p = c.profile;
  const savedContext = Object.fromEntries(
    Object.entries({
      name: p.name,
      businesses_and_projects: p.projects,
      goals: p.goals,
      main_outcome: p.mainOutcome,
      commitments: p.commitments,
      usual_working_hours: p.workStart && p.workEnd ? `${p.workStart}-${p.workEnd}` : p.workStart || p.workEnd,
      planning_preferences: p.preferences,
    }).filter(([, v]) => v),
  );
  const state = {
    now: { date: c.date, weekday: c.weekday, time: c.time, timezone: c.timezone },
    request_kind: c.kind,
    ...(c.learning?.factor
      ? {
          estimation_history: {
            typical_actual_vs_estimate: `${c.learning.factor}x`,
            completed_tasks_measured: c.learning.samples,
            by_project: c.learning.byProject.length ? c.learning.byProject : undefined,
            recent_examples: c.learning.recent,
          },
        }
      : {}),
    ...(c.lastWrapUp
      ? {
          last_wrap_up: {
            date: c.lastWrapUp.date,
            finished: c.lastWrapUp.doneTitles,
            carried_to_next_day: c.lastWrapUp.tomorrowTaskIds,
            note: c.lastWrapUp.note || undefined,
          },
        }
      : {}),
    ...(c.wrapUpToday ? { wrapped_up_today: true } : {}),
    ...(c.remainingUntil ? { user_can_work_until: c.remainingUntil } : {}),
    confirmed_context: Object.keys(savedContext).length ? savedContext : "nothing saved yet",
    saved_tasks: selectTasksForModel(c.tasks, c.plan, c.date).map(compactTask),
    todays_fixed_meetings: c.meetings.map((m) => ({ id: m.id, title: m.title, start: m.start, end: m.end })),
    ...(c.tomorrow
      ? {
          tomorrow: {
            date: c.tomorrow.date,
            weekday: c.tomorrow.weekday,
            fixed_meetings: c.tomorrow.meetings.map((m) => ({ title: m.title, start: m.start, end: m.end })),
            confirmed_plan: c.tomorrow.plan
              ? {
                  main_outcome: c.tomorrow.plan.mainOutcome,
                  focus_task_id: c.tomorrow.plan.focusTaskId,
                  window: c.tomorrow.plan.window,
                  blocks: c.tomorrow.plan.blocks.map((b) => ({ start: b.start, end: b.end, kind: b.kind, task_id: b.taskId })),
                }
              : null,
          },
        }
      : {}),
    ...(c.upcoming?.length
      ? { upcoming_commitments: c.upcoming.slice(0, 30).map((m) => ({ date: m.date, title: m.title, start: m.start, end: m.end })) }
      : {}),
    ...(c.declinedSuggestions?.length ? { declined_context_suggestions: c.declinedSuggestions } : {}),
    confirmed_plan_today: c.plan
      ? {
          version: c.plan.version,
          main_outcome: c.plan.mainOutcome,
          focus_task_id: c.plan.focusTaskId,
          supporting_task_ids: c.plan.supporting.map((s) => s.taskId),
          window: c.plan.window,
          work_budget_minutes: c.plan.workBudgetMinutes,
          blocks: c.plan.blocks.map((b) => ({ start: b.start, end: b.end, kind: b.kind, task_id: b.taskId, title: b.title })),
        }
      : null,
    pending_unconfirmed_proposal: c.proposal?.plan
      ? { date: c.proposal.plan.date, main_outcome: c.proposal.plan.mainOutcome, focus_task_id: c.proposal.plan.focusTaskId, window: c.proposal.plan.window }
      : null,
  };
  return `<app_state>\n${JSON.stringify(state, null, 1)}\n</app_state>`;
}

const HISTORY_MESSAGES = 16;
const HISTORY_CHARS = 12_000;

/** A bounded slice of recent conversation, oldest first, starting with a user turn. */
export function boundedHistory(messages: ChatMessage[]): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  let chars = 0;
  for (const m of [...messages].reverse()) {
    if (out.length >= HISTORY_MESSAGES) break;
    if (m.meta.system) continue;
    let content = m.text;
    if (m.role === "assistant" && m.meta.questions?.length) content += `\n(Questions asked: ${m.meta.questions.join(" | ")})`;
    if (chars + content.length > HISTORY_CHARS) break;
    chars += content.length;
    out.unshift({ role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}
