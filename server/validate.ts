import type { Meeting, PlanDraft, Task } from "../shared/types.js";
import { isValidDate, isValidTime, toMinutes } from "./time.js";

export interface PlanCheckContext {
  meetings: Meeting[];
  tasks: Map<string, Task>;
  /** When replanning: blocks not in `preservedBlockIds` must not start before this time. */
  notBefore?: string | null;
  preservedBlockIds?: Set<string>;
}

const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;

export const WORK_KINDS = new Set(["focus", "task"]);

export function workMinutes(d: Pick<PlanDraft, "blocks">) {
  return d.blocks.filter((b) => WORK_KINDS.has(b.kind)).reduce((s, b) => s + (toMinutes(b.end) - toMinutes(b.start)), 0);
}

export function freeMinutes(window: { start: string; end: string }, meetings: Meeting[]) {
  const ws = toMinutes(window.start);
  const we = toMinutes(window.end);
  let total = Math.max(0, we - ws);
  for (const m of meetings) {
    const s = Math.max(ws, toMinutes(m.start));
    const e = Math.min(we, toMinutes(m.end));
    if (e > s) total -= e - s;
  }
  return total;
}

/** Returns a list of human-readable problems. Empty list = valid. */
export function validatePlanDraft(d: PlanDraft, ctx: PlanCheckContext): string[] {
  const errors: string[] = [];
  if (!isValidDate(d.date)) errors.push(`Invalid plan date "${d.date}".`);
  if (!isValidTime(d.window.start) || !isValidTime(d.window.end)) {
    errors.push(`Working window must use HH:MM times (got ${d.window.start}–${d.window.end}).`);
    return errors;
  }
  const ws = toMinutes(d.window.start);
  const we = toMinutes(d.window.end);
  if (we <= ws) errors.push(`Working window end ${d.window.end} must be after start ${d.window.start}.`);

  const meetingById = new Map(ctx.meetings.map((m) => [m.id, m]));
  const blocks = [...d.blocks];
  for (const b of blocks) {
    if (!isValidTime(b.start) || !isValidTime(b.end)) {
      errors.push(`Block "${b.title}" has an invalid time (${b.start}–${b.end}); use HH:MM 24-hour times.`);
      continue;
    }
    if (toMinutes(b.end) <= toMinutes(b.start)) errors.push(`Block "${b.title}" ends before it starts (${b.start}–${b.end}).`);
  }
  if (errors.length) return errors;

  blocks.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  for (let i = 1; i < blocks.length; i++) {
    const p = blocks[i - 1];
    const c = blocks[i];
    if (toMinutes(c.start) < toMinutes(p.end)) {
      errors.push(`Blocks overlap: "${p.title}" (${p.start}–${p.end}) and "${c.title}" (${c.start}–${c.end}).`);
    }
  }

  for (const b of blocks) {
    const bs = toMinutes(b.start);
    const be = toMinutes(b.end);
    if (b.kind === "meeting") {
      const m = b.meetingId ? meetingById.get(b.meetingId) : undefined;
      if (!m) {
        errors.push(`Meeting block "${b.title}" (${b.start}–${b.end}) does not match a saved fixed meeting.`);
      } else if (m.start !== b.start || m.end !== b.end) {
        errors.push(`Fixed meeting "${m.title}" is ${m.start}–${m.end}; the plan may not move it to ${b.start}–${b.end}.`);
      }
      continue;
    }
    if (bs < ws || be > we) {
      errors.push(`Block "${b.title}" (${b.start}–${b.end}) is outside the available window ${d.window.start}–${d.window.end}.`);
    }
    for (const m of ctx.meetings) {
      if (overlaps(bs, be, toMinutes(m.start), toMinutes(m.end))) {
        errors.push(`Block "${b.title}" (${b.start}–${b.end}) overlaps the fixed meeting "${m.title}" (${m.start}–${m.end}).`);
      }
    }
    if (WORK_KINDS.has(b.kind)) {
      if (!b.taskId) errors.push(`Work block "${b.title}" must reference a task.`);
      else if (!ctx.tasks.has(b.taskId)) errors.push(`Work block "${b.title}" references unknown task "${b.taskId}".`);
    }
    if (ctx.notBefore && !ctx.preservedBlockIds?.has(b.id) && bs < toMinutes(ctx.notBefore)) {
      errors.push(`Block "${b.title}" starts at ${b.start}, which is already in the past (now ${ctx.notBefore}).`);
    }
  }

  const work = workMinutes(d);
  const free = freeMinutes(d.window, ctx.meetings);
  if (d.workBudgetMinutes > free) {
    errors.push(`Work budget ${d.workBudgetMinutes} min is more than the ${free} min free in the window after meetings.`);
  }
  if (work > d.workBudgetMinutes) {
    errors.push(`Planned work is ${work} min but the confirmed budget is ${d.workBudgetMinutes} min.`);
  }

  const refs = [
    ...(d.focusTaskId ? [d.focusTaskId] : []),
    ...d.supporting.map((s) => s.taskId),
    ...d.deferred.map((s) => s.taskId),
  ];
  for (const r of refs) if (!ctx.tasks.has(r)) errors.push(`Plan references unknown task "${r}".`);
  if (d.supporting.length > 2) errors.push(`Recommend at most two supporting actions (got ${d.supporting.length}).`);
  if (d.focusTaskId && d.supporting.some((s) => s.taskId === d.focusTaskId)) {
    errors.push("The main focus should not also be listed as a supporting action.");
  }
  return errors;
}

export function validateMeeting(m: { title: string; start: string; end: string }, existing: Meeting[], ignoreId?: string): string[] {
  const errors: string[] = [];
  if (!m.title.trim()) errors.push("Meeting needs a title.");
  if (!isValidTime(m.start) || !isValidTime(m.end)) return [...errors, `Meeting times must be HH:MM (got ${m.start}–${m.end}).`];
  if (toMinutes(m.end) <= toMinutes(m.start)) errors.push(`Meeting "${m.title}" ends before it starts.`);
  for (const e of existing) {
    if (e.id === ignoreId) continue;
    if (overlaps(toMinutes(m.start), toMinutes(m.end), toMinutes(e.start), toMinutes(e.end))) {
      errors.push(`"${m.title}" (${m.start}–${m.end}) overlaps saved meeting "${e.title}" (${e.start}–${e.end}).`);
    }
  }
  return errors;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an|my|to|for|on|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Finds an existing not-done task with essentially the same title. */
export function findDuplicate(title: string, tasks: Task[]): Task | null {
  const n = norm(title);
  if (!n) return null;
  return tasks.find((t) => t.status !== "done" && norm(t.title) === n) ?? null;
}
