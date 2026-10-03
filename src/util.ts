import type { Plan, PlanBlock, PlanDraft, Task } from "../shared/types";

export const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
export const fromMin = (n: number) => {
  const c = Math.max(0, Math.min(23 * 60 + 59, n));
  return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;
};

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
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

export function capacity(plan: Pick<PlanDraft, "blocks" | "window" | "workBudgetMinutes">) {
  const sum = (k: string[]) => plan.blocks.filter((b) => k.includes(b.kind)).reduce((s, b) => s + blockMinutes(b), 0);
  const meetings = plan.blocks
    .filter((b) => b.kind === "meeting")
    .reduce((s, b) => s + Math.max(0, Math.min(toMin(b.end), toMin(plan.window.end)) - Math.max(toMin(b.start), toMin(plan.window.start))), 0);
  return {
    available: Math.max(0, toMin(plan.window.end) - toMin(plan.window.start) - meetings),
    work: sum(["focus", "task"]),
    breaks: sum(["break"]),
    buffer: sum(["buffer"]),
    meetings,
    budget: plan.workBudgetMinutes,
  };
}

export function draftOf(plan: Plan): PlanDraft {
  const { id: _i, version: _v, status: _s, createdAt: _c, proposalId: _p, source: _so, ...draft } = plan;
  return structuredClone(draft);
}

export const taskById = (tasks: Task[]) => new Map(tasks.map((t) => [t.id, t]));
