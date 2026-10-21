import type { Plan, PlanBlock, PlanDraft, Task } from "../shared/types";

export const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
export const fromMin = (n: number) => {
  const c = Math.max(0, Math.min(23 * 60 + 59, n));
  return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;
};

const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
export function fmtTime(t: string) {
  if (!/^\d{2}:\d{2}$/.test(t)) return t;
  const d = new Date(2000, 0, 1, Number(t.slice(0, 2)), Number(t.slice(3)));
  return timeFmt.format(d);
}
export const fmtRange = (a: string, b: string) => `${fmtTime(a)} – ${fmtTime(b)}`;

export function fmtDuration(min: number) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function fmtDate(date: string, weekday = true) {
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: weekday ? "long" : undefined, month: "long", day: "numeric" });
}

export const blockMinutes = (b: Pick<PlanBlock, "start" | "end">) => toMin(b.end) - toMin(b.start);

/**
 * How the day's working window splits up. Overlapping meetings are counted once and
 * clipped to the window, so free = work + breaks + buffer + open always adds up.
 */
export function capacity(plan: Pick<PlanDraft, "blocks" | "window" | "workBudgetMinutes">) {
  const ws = toMin(plan.window.start);
  const we = toMin(plan.window.end);
  const sum = (k: string[]) => plan.blocks.filter((b) => k.includes(b.kind)).reduce((s, b) => s + blockMinutes(b), 0);
  const spans = plan.blocks
    .filter((b) => b.kind === "meeting")
    .map((b) => [Math.max(toMin(b.start), ws), Math.min(toMin(b.end), we)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let meetings = 0;
  let reach = ws;
  for (const [a, b] of spans) {
    if (b <= reach) continue;
    meetings += b - Math.max(a, reach);
    reach = b;
  }
  const window = Math.max(0, we - ws);
  const available = Math.max(0, window - meetings);
  const work = sum(["focus", "task"]);
  const breaks = sum(["break"]);
  const buffer = sum(["buffer"]);
  return {
    window,
    available,
    work,
    breaks,
    buffer,
    open: Math.max(0, available - work - breaks - buffer),
    meetings,
    budget: plan.workBudgetMinutes,
  };
}

export function draftOf(plan: Plan): PlanDraft {
  const { id: _i, version: _v, status: _s, createdAt: _c, proposalId: _p, source: _so, ...draft } = plan;
  return structuredClone(draft);
}

export const taskById = (tasks: Task[]) => new Map(tasks.map((t) => [t.id, t]));
