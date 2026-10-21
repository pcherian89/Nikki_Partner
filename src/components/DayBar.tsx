import type { PlanDraft } from "../../shared/types";
import { capacity, fmtDuration, fmtRange, toMin } from "../util";

/**
 * "Your day": the whole working window as one bar. Meetings + work + breaks + buffer + free always add up
 * to the window, so the numbers can be checked at a glance. Used for confirmed plans and drafts alike.
 */
export function DayBar({ plan, now, title = "Your day" }: { plan: Pick<PlanDraft, "blocks" | "window" | "workBudgetMinutes">; now?: string; title?: string }) {
  const c = capacity(plan);
  if (!c.window) return null;
  // The whole working window, so every part adds up to it: meetings + work + breaks + buffer + free.
  const parts = [
    { key: "meeting", label: "Meetings", value: c.meetings },
    { key: "work", label: "Work", value: c.work },
    { key: "break", label: "Breaks", value: c.breaks },
    { key: "buffer", label: "Buffer", value: c.buffer },
    { key: "open", label: "Unscheduled", value: c.open },
  ].filter((p) => p.value > 0);
  const left = now && toMin(now) > toMin(plan.window.start) && toMin(now) < toMin(plan.window.end) ? toMin(plan.window.end) - toMin(now) : null;
  return (
    <div className="card capacity" aria-label="How your working day adds up">
      <div className="row between center-y wrap gap">
        <h3 className="h3 cap-title">{title}</h3>
        <span className="muted small">
          {fmtRange(plan.window.start, plan.window.end)} · {fmtDuration(c.window)}
          {left != null ? ` · ${fmtDuration(left)} left` : ""}
        </span>
      </div>
      <div className="cap-bar" aria-hidden>
        {parts.map((p) => (
          <span key={p.key} className={`cap-${p.key}`} style={{ flexGrow: p.value }} />
        ))}
      </div>
      <ul className="cap-legend">
        {parts.map((p) => (
          <li key={p.key}>
            <span className={`cap-swatch cap-${p.key}`} aria-hidden />
            {p.label} <strong>{fmtDuration(p.value)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
