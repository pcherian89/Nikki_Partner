import type { ChatMessage, Meeting, Plan, Profile, Task } from "../shared/types.js";
import type { ModelResponse } from "./schema.js";
import { scheduleBlocks, ScheduleItem } from "./scheduler.js";
import { fromMinutes, isValidTime, roundUpTo, toMinutes } from "./time.js";
import { freeMinutes } from "./validate.js";

/**
 * Demo mode: a deterministic, rule-based stand-in for the model. It is NOT an
 * LLM. It parses simple phrases ("five hours", "2–4 meeting", "need to A, B
 * and C"), asks scripted clarification questions and builds a schedule with
 * the deterministic scheduler. Its output goes through exactly the same
 * validation and persistence path as live model output.
 */

export const EXAMPLE_DUMP =
  "I have five hours today, except 2–4 when I have a meeting. I need to finish a proposal, review beta feedback, apply for jobs, and explore a business idea.";

export interface DemoInput {
  text: string;
  kind: "chat" | "replan" | "review";
  remainingUntil?: string | null;
  profile: Profile;
  tasks: Task[];
  meetings: Meeting[];
  plan: Plan | null;
  now: string;
  lastAssistant: ChatMessage | null;
}

export interface DemoInfo {
  hours: number | null;
  meeting: { start: string; end: string } | null;
  start: string | null;
  excludesMeeting: boolean | null;
  outcome: string | null;
}

export interface DemoResult {
  response: ModelResponse;
  meta: { demoPhase?: string; demoInfo?: DemoInfo; exampleAnswer?: string };
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function parseHours(text: string): number | null {
  const m = text.match(/\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:hours?|hrs?|h)\b/i);
  if (!m) return null;
  const v = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
  return Number.isFinite(v) && v > 0 && v <= 16 ? v : null;
}

function to24(h: number, min: number, ampm: string | undefined, assumeAfternoon: boolean) {
  let hh = h;
  const ap = ampm?.toLowerCase();
  if (ap === "pm" && hh < 12) hh += 12;
  else if (ap === "am" && hh === 12) hh = 0;
  else if (!ap && assumeAfternoon && hh >= 1 && hh <= 7) hh += 12;
  if (hh > 23 || min > 59) return null;
  return fromMinutes(hh * 60 + min);
}

export function parseMeeting(text: string): { start: string; end: string; title: string } | null {
  if (!/\b(meeting|call|appointment|interview|sync|standup)\b/i.test(text)) return null;
  const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  const endAmPm = m[6];
  const start = to24(Number(m[1]), Number(m[2] ?? 0), m[3] ?? endAmPm, true);
  const end = to24(Number(m[4]), Number(m[5] ?? 0), endAmPm, true);
  if (!start || !end || toMinutes(end) <= toMinutes(start)) return null;
  const kind = text.match(/\b(meeting|call|appointment|interview|sync|standup)\b/i)![1].toLowerCase();
  return { start, end, title: kind[0].toUpperCase() + kind.slice(1) };
}

export function parseStart(text: string): string | null {
  const m =
    text.match(/\b(?:start(?:ing)?|begin(?:ning)?|from)\s*(?:at|around|about)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i) ??
    text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  return to24(Number(m[1]), Number(m[2] ?? 0), m[3], false);
}

export function parseExcludes(text: string): boolean | null {
  if (/\b(not including|exclud\w*|outside|on top of|plus the|yes)\b/i.test(text)) return true;
  if (/\b(includ\w*|no)\b/i.test(text)) return false;
  return null;
}

export function parseOutcome(text: string): string | null {
  const m = text.match(/(?:main outcome|outcome|success|a win|win)\s*(?:is|would be|=|:|-|–)?\s*(?:to\s+)?([^.!?\n]+)/i);
  return m ? m[1].trim().replace(/^(to|is|be)\s+/i, "") : null;
}

export function parseItems(text: string): { title: string; kind: "action" | "idea" }[] {
  const out: string[] = [];
  for (const line of text.split(/\n/)) {
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)/);
    if (bullet) out.push(bullet[1]);
  }
  const re = /\b(?:i\s+)?(?:need to|have to|must|should|want to|got to|gotta|plan to|also)\s+([^.!?\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (const part of m[1].split(/,|;|\band\b|\bthen\b/i)) out.push(part);
  }
  const seen = new Set<string>();
  return out
    .map((s) => s.trim().replace(/^(to|and|also)\s+/i, "").replace(/[.\s]+$/, ""))
    .filter((s) => s.length >= 3 && s.split(" ").length <= 14)
    .filter((s) => {
      const k = s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((s) => ({
      title: s[0].toUpperCase() + s.slice(1),
      kind: /\b(explore|idea|maybe|someday|consider|brainstorm|look into|think about)\b/i.test(s) ? ("idea" as const) : ("action" as const),
    }));
}

export function estimateFor(title: string): number {
  if (/\b(proposal|write|draft|build|finish|prepare|deck|report|design)\b/i.test(title)) return 120;
  if (/\b(review|feedback|read|analy[sz]e|research)\b/i.test(title)) return 60;
  if (/\b(apply|application|jobs?)\b/i.test(title)) return 60;
  if (/\b(email|call|reply|send|book|pay|text)\b/i.test(title)) return 20;
  return 45;
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);

function bestMatch(outcome: string | null, tasks: Task[]): Task | null {
  if (!outcome || !tasks.length) return null;
  const ow = words(outcome);
  let best: Task | null = null;
  let score = 0;
  for (const t of tasks) {
    const s = [...words(t.title)].filter((w) => ow.has(w) || ow.has(w.replace(/s$/, ""))).length;
    if (s > score) {
      score = s;
      best = t;
    }
  }
  return best;
}

const empty = (): ModelResponse => ({
  message: "",
  questions: [],
  captured_items: [],
  task_updates: [],
  meetings: [],
  context_updates: [],
  availability: null,
  plan: null,
});

const fmtHours = (h: number) => `${WORDS_REV[h] ?? h} hour${h === 1 ? "" : "s"}`;
const WORDS_REV: Record<number, string> = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [v, k]));

export function demoRespond(input: DemoInput): DemoResult {
  if (input.kind === "replan") return demoReplan(input);

  const text = input.text.trim();
  const last = input.lastAssistant;
  const awaiting = last?.meta.demo && last.meta.demoPhase === "clarify" ? (last.meta.demoInfo as DemoInfo) : null;

  if (awaiting) {
    const info: DemoInfo = {
      ...awaiting,
      start: parseStart(text) ?? awaiting.start,
      excludesMeeting: parseExcludes(text) ?? awaiting.excludesMeeting,
      outcome: parseOutcome(text) ?? (text.length < 140 ? text : awaiting.outcome),
    };
    return proposeFromInfo(input, info, []);
  }

  const items = parseItems(text);
  const meeting = parseMeeting(text);
  const hours = parseHours(text);
  const info: DemoInfo = {
    hours,
    meeting: meeting ? { start: meeting.start, end: meeting.end } : null,
    start: parseStart(text.replace(/\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|—|to|until)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi, "")),
    excludesMeeting: null,
    outcome: parseOutcome(text),
  };

  const res = empty();
  const existing = new Set(input.tasks.filter((t) => t.status !== "done").map((t) => t.title.toLowerCase()));
  res.captured_items = items
    .filter((i) => !existing.has(i.title.toLowerCase()))
    .map((i, idx) => ({
      ref: `n${idx + 1}`,
      kind: i.kind,
      title: i.title,
      notes: null,
      estimate_minutes: i.kind === "action" ? estimateFor(i.title) : null,
      deadline: null,
      project: null,
      duplicate_of: null,
    }));
  if (meeting && !input.meetings.some((m) => m.start === meeting.start && m.end === meeting.end)) {
    res.meetings.push(meeting);
  }

  const nameMatch = text.match(/\bmy name is ([A-Z][a-z]+)/);
  if (nameMatch && nameMatch[1] !== input.profile.name) {
    res.context_updates.push({ field: "name", value: nameMatch[1], reason: "You told me your name." });
  }

  if (!items.length && !hours && !meeting) {
    res.message = /\b(update|replan|re-plan)\b/i.test(text)
      ? "To update today's plan, use the “Update my plan” button on the Today panel — I'll ask how much time you have left."
      : "I'm running in Demo mode, so I follow a simple script rather than understanding everything. Try listing what's on your mind, e.g. “I have 4 hours. I need to write the report, call the bank and plan the launch.” — or tap “Try an example”.";
    return { response: res, meta: { demoPhase: "idle" } };
  }

  const actions = res.captured_items.filter((c) => c.kind === "action");
  const ideas = res.captured_items.filter((c) => c.kind === "idea");
  const knownStart = info.start ?? (isValidTime(input.profile.workStart) ? input.profile.workStart : null);
  const questions: string[] = [];
  const meetingLabel = info.meeting ? `${info.meeting.start}–${info.meeting.end}` : "";
  if (!knownStart && hours && info.meeting) {
    questions.push(`What time will you start, and do your ${fmtHours(hours)} already exclude the ${meetingLabel} meeting?`);
  } else if (!knownStart) {
    questions.push(hours ? "What time will you start working today?" : "What time will you start, and when do you need to stop today?");
  } else if (hours && info.meeting) {
    questions.push(`Do your ${fmtHours(hours)} already exclude the ${meetingLabel} meeting?`);
  }
  if (!info.outcome && actions.length + input.tasks.filter((t) => t.type === "action" && t.status === "open").length > 1) {
    questions.push("What's the one outcome that would make today feel like a win?");
  }

  const capturedLine = [
    actions.length ? `${actions.length} action${actions.length > 1 ? "s" : ""}` : "",
    ideas.length ? `${ideas.length} idea${ideas.length > 1 ? "s" : ""} (parked — not an obligation)` : "",
    res.meetings.length ? `your ${res.meetings[0].start}–${res.meetings[0].end} ${res.meetings[0].title.toLowerCase()}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  if (questions.length) {
    res.message = `Got it — I've captured ${capturedLine || "that"}. Two quick things before I suggest priorities:`;
    if (questions.length === 1) res.message = `Got it — I've captured ${capturedLine || "that"}. One quick question before I suggest priorities:`;
    res.questions = questions.slice(0, 2);
    const firstAction = actions[0]?.title.toLowerCase() ?? "the most important task";
    const timing = [
      !knownStart ? "Start at 10am" : "",
      hours && info.meeting ? `${!knownStart ? "and yes" : "Yes"}, the ${fmtHours(hours)} are outside the meeting` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const exampleAnswer = [timing, !info.outcome ? `Main outcome: ${firstAction}` : ""].filter(Boolean).join(". ").concat(".");
    return { response: res, meta: { demoPhase: "clarify", demoInfo: info, exampleAnswer } };
  }
  return proposeFromInfo(input, info, res.captured_items, res);
}

function proposeFromInfo(
  input: DemoInput,
  info: DemoInfo,
  newItems: ModelResponse["captured_items"],
  base: ModelResponse = empty(),
): DemoResult {
  const res = base;
  const assumptions: string[] = [];
  let start = info.start;
  if (!start && isValidTime(input.profile.workStart)) start = input.profile.workStart;
  if (!start) {
    start = "09:00";
    assumptions.push("You'll start at 09:00 (you didn't say).");
  }
  const meetings: Meeting[] = [...input.meetings];
  for (const m of res.meetings) meetings.push({ id: "pending", date: "", ...m });
  if (info.meeting && !meetings.some((m) => m.start === info.meeting!.start)) {
    meetings.push({ id: "pending", date: "", title: "Meeting", ...info.meeting });
  }

  const s = toMinutes(start);
  let end: number;
  let budget: number;
  if (info.hours) {
    budget = Math.round(info.hours * 60);
    end = s + budget;
    const excludes = info.excludesMeeting ?? true;
    if (info.excludesMeeting === null && meetings.length) assumptions.push(`Your ${fmtHours(info.hours)} don't include meeting time.`);
    if (excludes) {
      for (const m of [...meetings].sort((a, b) => toMinutes(a.start) - toMinutes(b.start))) {
        if (toMinutes(m.start) < end && toMinutes(m.end) > s) end += toMinutes(m.end) - Math.max(toMinutes(m.start), s);
      }
    }
  } else if (isValidTime(input.profile.workEnd) && toMinutes(input.profile.workEnd) > s) {
    end = toMinutes(input.profile.workEnd);
    budget = Infinity;
  } else {
    end = s + 8 * 60;
    budget = Infinity;
    assumptions.push("A standard working day (8 hours) since you didn't say how long you have.");
  }
  end = Math.min(end, 23 * 60 + 30);
  const window = { start, end: fromMinutes(end) };
  budget = Math.min(budget, freeMinutes(window, meetings));

  type Cand = { ref: string; title: string; minutes: number };
  const existingActions: Cand[] = input.tasks
    .filter((t) => t.type === "action" && t.status === "open")
    .map((t) => ({ ref: t.id, title: t.title, minutes: t.estimateMinutes ?? estimateFor(t.title) }));
  const newActions: Cand[] = newItems
    .filter((c) => c.kind === "action")
    .map((c) => ({ ref: c.ref, title: c.title, minutes: c.estimate_minutes ?? estimateFor(c.title) }));
  const cands = [...existingActions, ...newActions];
  if (!cands.length) {
    res.message = "I don't see any actions to plan yet. Tell me what you need to get done today.";
    return { response: res, meta: { demoPhase: "idle" } };
  }
  const asTask = (c: Cand) => ({ id: c.ref, title: c.title }) as Task;
  const focusMatch = bestMatch(info.outcome, cands.map(asTask));
  const focus = cands.find((c) => c.ref === focusMatch?.id) ?? cands[0];
  const rest = cands.filter((c) => c !== focus);
  const items: ScheduleItem[] = [
    { ...focus, kind: "focus" },
    ...rest.slice(0, 2).map((c) => ({ ...c, kind: "task" as const })),
  ];
  const sched = scheduleBlocks({ window, meetings, budgetMinutes: budget, items });
  const scheduledRefs = new Set(sched.placed.map((p) => p.ref));
  const supporting = rest.slice(0, 2).filter((c) => scheduledRefs.has(c.ref));
  const deferredActions = cands.filter((c) => c !== focus && !supporting.includes(c));
  const ideas = [
    ...input.tasks.filter((t) => t.type === "idea" && t.status !== "done").map((t) => ({ ref: t.id, title: t.title })),
    ...newItems.filter((c) => c.kind === "idea").map((c) => ({ ref: c.ref, title: c.title })),
  ];
  const workPlanned = sched.placed.reduce((a, p) => a + p.minutes, 0);
  const outcome = info.outcome ? info.outcome[0].toUpperCase() + info.outcome.slice(1) : `${focus.title} — done`;

  res.availability = {
    window_start: window.start,
    window_end: window.end,
    work_budget_minutes: Number.isFinite(budget) ? budget : null,
    budget_excludes_meetings: info.excludesMeeting,
  };
  res.plan = {
    main_outcome: outcome,
    focus: { task_ref: focus.ref, why: "It's tied to your main outcome, so it gets the first and longest uninterrupted stretch." },
    supporting: supporting.map((c) => ({ task_ref: c.ref, why: "Meaningful progress that fits after the focus work." })),
    deferred: [
      ...deferredActions.map((c) => ({ task_ref: c.ref, why: "Doesn't fit today without squeezing the focus work." })),
      ...ideas.map((i) => ({ task_ref: i.ref, why: "An idea to explore later — parked, not an obligation today." })),
    ],
    window,
    work_budget_minutes: Number.isFinite(budget) ? budget : Math.max(workPlanned, 0),
    blocks: sched.blocks,
    reasons: [
      `${focus.title} is the main focus because it moves your main outcome forward.`,
      supporting.length ? `${supporting.map((c) => c.title).join(" and ")} support it and fit the remaining time.` : "Nothing else fits without crowding the focus.",
      ideas.length ? "Ideas stay parked so they don't compete with today's commitments." : "Breaks and a buffer protect against overruns.",
    ],
    assumptions,
  };
  const hrs = Math.round((workPlanned / 60) * 10) / 10;
  res.message = `Here's a realistic plan: ${hrs} hours of focused work between ${window.start} and ${window.end}, around your fixed commitments. Main focus: ${focus.title}.${supporting.length ? ` Then ${supporting.map((c) => c.title.toLowerCase()).join(" and ")}.` : ""} Review the blocks, adjust anything, then confirm.`;
  return { response: res, meta: { demoPhase: "proposed" } };
}

function demoReplan(input: DemoInput): DemoResult {
  const res = empty();
  const plan = input.plan;
  const until = input.remainingUntil ?? plan?.window.end ?? (isValidTime(input.profile.workEnd) ? input.profile.workEnd : null);
  if (!until) {
    res.message = "Happy to update the plan. Until what time can you keep working today?";
    res.questions = ["Until what time can you keep working today?"];
    return { response: res, meta: { demoPhase: "replan-ask" } };
  }
  const startMin = roundUpTo(toMinutes(input.now), 15);
  if (startMin >= toMinutes(until) - 15) {
    res.message = `There's no meaningful time left before ${until}. Anything unfinished can roll over to tomorrow — I'll offer to review it when you're back.`;
    return { response: res, meta: { demoPhase: "idle" } };
  }
  const window = { start: plan && toMinutes(plan.window.start) < startMin ? plan.window.start : fromMinutes(startMin), end: until };
  const done = new Set(input.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const open = input.tasks.filter((t) => t.type === "action" && t.status === "open");
  const ordered: Task[] = [];
  const push = (id: string | null | undefined) => {
    const t = open.find((x) => x.id === id);
    if (t && !ordered.includes(t)) ordered.push(t);
  };
  push(plan?.focusTaskId);
  plan?.supporting.forEach((s) => push(s.taskId));
  open.forEach((t) => push(t.id));
  if (!ordered.length) {
    res.message = "Everything in today's plan is done. Nice work — enjoy the rest of your day, or tell me what else is on your mind.";
    return { response: res, meta: { demoPhase: "idle" } };
  }
  const pastWork = (plan?.blocks ?? [])
    .filter((b) => (b.kind === "focus" || b.kind === "task") && (toMinutes(b.end) <= startMin || (b.taskId && done.has(b.taskId))))
    .reduce((a, b) => a + toMinutes(b.end) - toMinutes(b.start), 0);
  const free = freeMinutes({ start: fromMinutes(startMin), end: until }, input.meetings);
  const budget = Math.max(0, Math.min(free, plan ? Math.max(plan.workBudgetMinutes - pastWork, 0) || free : free));
  const items: ScheduleItem[] = ordered.slice(0, 3).map((t, i) => {
    const doneBefore = (plan?.blocks ?? [])
      .filter((b) => b.taskId === t.id && toMinutes(b.end) <= startMin)
      .reduce((a, b) => a + toMinutes(b.end) - toMinutes(b.start), 0);
    return {
      ref: t.id,
      title: t.title,
      minutes: Math.max(30, (t.estimateMinutes ?? estimateFor(t.title)) - doneBefore),
      kind: i === 0 ? "focus" : "task",
    };
  });
  const sched = scheduleBlocks({ window, startAt: fromMinutes(startMin), meetings: input.meetings, budgetMinutes: budget, items });
  const placed = new Set(sched.placed.map((p) => p.ref));
  const focus = items.find((i) => placed.has(i.ref)) ?? items[0];
  const completed = input.tasks.filter((t) => done.has(t.id) && plan?.blocks.some((b) => b.taskId === t.id));
  res.plan = {
    main_outcome: plan?.mainOutcome ?? `${focus.title} — done`,
    focus: { task_ref: focus.ref, why: focus.ref === plan?.focusTaskId ? "Still your main focus — priorities stay stable." : "The earlier focus is done or blocked, so this is next." },
    supporting: items.filter((i) => i !== focus && placed.has(i.ref)).slice(0, 2).map((i) => ({ task_ref: i.ref, why: "Still fits in the time left." })),
    deferred: items.filter((i) => !placed.has(i.ref)).map((i) => ({ task_ref: i.ref, why: "Not enough time left today." })),
    window,
    work_budget_minutes: budget,
    blocks: sched.blocks.filter((b) => b.kind !== "meeting" || toMinutes(b.end) > startMin),
    reasons: [
      completed.length ? `Done so far: ${completed.map((t) => t.title).join(", ")}.` : "Nothing marked done yet — that's fine.",
      `Remaining time from ${fromMinutes(startMin)} to ${until}, around fixed meetings.`,
    ],
    assumptions: input.remainingUntil ? [] : [`You can keep working until ${until}.`],
  };
  res.message = `Here's an updated plan from ${fromMinutes(startMin)} to ${until}. Completed work and fixed meetings stay as they are. Review the changes, then confirm.`;
  return { response: res, meta: { demoPhase: "proposed" } };
}
