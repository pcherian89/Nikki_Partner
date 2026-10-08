import type { EstimationInsight, Task } from "../shared/types.js";

/**
 * Learns how long the user's tasks really take compared with their estimates,
 * from completed tasks that have both. Uses the median ratio so one outlier
 * doesn't skew it. Needs at least 3 samples before giving a factor.
 */
export const MIN_SAMPLES = 3;

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function estimationInsight(tasks: Task[]): EstimationInsight {
  const done = tasks
    .filter((t) => t.status === "done" && t.estimateMinutes && t.actualMinutes && t.actualMinutes > 0)
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
    .slice(0, 40);
  // Clamp ratios so a typo (e.g. 600 instead of 60) can't distort the result.
  const ratio = (t: Task) => Math.min(4, Math.max(0.25, t.actualMinutes! / t.estimateMinutes!));
  const factor = done.length >= MIN_SAMPLES ? round2(median(done.map(ratio))) : null;
  const projects = new Map<string, Task[]>();
  for (const t of done) if (t.project) projects.set(t.project, [...(projects.get(t.project) ?? []), t]);
  const byProject = [...projects.entries()]
    .filter(([, ts]) => ts.length >= MIN_SAMPLES)
    .map(([project, ts]) => ({ project, factor: round2(median(ts.map(ratio))), samples: ts.length }));
  return {
    samples: done.length,
    factor,
    byProject,
    recent: done.slice(0, 6).map((t) => ({ title: t.title, estimate: t.estimateMinutes!, actual: t.actualMinutes! })),
  };
}

/** Applies the learned factor to a raw estimate (rounded to 5 minutes). */
export function adjustEstimate(minutes: number, insight: EstimationInsight, project?: string | null) {
  const f = insight.byProject.find((p) => p.project === project)?.factor ?? insight.factor;
  if (!f) return minutes;
  return Math.max(5, Math.round((minutes * f) / 5) * 5);
}
