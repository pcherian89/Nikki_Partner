import { useState } from "react";
import type { AppState, Meeting, Task } from "../../shared/types";
import type { AppActions } from "../App";
import { fmtDate, fmtDuration, fmtRange } from "../util";
import { ProposalCard } from "./ProposalCard";
import { useCompletion } from "./Today";

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekdayShort = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
const dayNum = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

/** A proposal that only assigns tasks to days (no timed plan) belongs to the week view. */
export const isWeekProposal = (p: AppState["proposal"]) => !!p && !p.plan && p.taskChanges.some((c) => c.plannedDate);

export function Week({ state, actions, onOpenDay, busy }: { state: AppState; actions: AppActions; onOpenDay: (d: "today" | "tomorrow") => void; busy: boolean }) {
  const complete = useCompletion(state, actions);
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.today, i));
  const end = days[6];
  const later = addDays(state.today, 30);
  const meetingsOn = (d: string): Meeting[] =>
    d === state.today ? state.meetings : d === state.tomorrow.date ? state.tomorrow.meetings : state.upcoming.filter((m) => m.date === d);
  const open = state.tasks.filter((t) => t.type === "action" && t.status !== "done");
  const plannedOn = (d: string) =>
    open.filter((t) => t.plannedDate === d || (d === state.today && t.plannedDate != null && t.plannedDate < state.today));
  const dueOn = (d: string) => state.tasks.filter((t) => t.status !== "done" && t.deadline === d);
  const overdueDeadlines = state.tasks.filter((t) => t.status !== "done" && t.deadline && t.deadline < state.today);
  const inTodayPlan = new Set(state.plan?.blocks.map((b) => b.taskId).filter(Boolean));
  const unscheduled = open.filter((t) => !t.plannedDate && !inTodayPlan.has(t.id));
  const laterItems = [
    ...state.upcoming.filter((m) => m.date > end && m.date <= later).map((m) => ({ key: m.id, date: m.date, text: m.title, time: fmtRange(m.start, m.end), kind: "event" as const })),
    ...state.tasks
      .filter((t) => t.status !== "done" && t.deadline && t.deadline > end && t.deadline <= later)
      .map((t) => ({ key: t.id, date: t.deadline!, text: t.title, time: "", kind: "deadline" as const })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const proposal = isWeekProposal(state.proposal) ? state.proposal : null;

  const setPlanned = (t: Task, d: string | null) => actions.mutate("PATCH", `/api/tasks/${t.id}`, { plannedDate: d });

  return (
    <>
      <div className="today-head">
        <div>
          <div className="eyebrow">
            {dayNum(days[0])} – {dayNum(end)}
          </div>
          <h2 className="h2">This week</h2>
          <div className="muted small">Rough plan by day. Exact times are set the day before.</div>
        </div>
        <button className="btn" onClick={() => actions.focusComposer("Help me spread my open tasks across this week. ")} disabled={busy}>
          Plan my week with Nikki
        </button>
      </div>

      {proposal && <ProposalCard state={state} proposal={proposal} actions={actions} onShowPlan={() => window.scrollTo({ top: 0, behavior: "smooth" })} />}

      <div className="week">
        {days.map((d, i) => {
          const meetings = meetingsOn(d);
          const planned = plannedOn(d);
          const due = [...dueOn(d), ...(i === 0 ? overdueDeadlines : [])];
          const dayPlan = d === state.today ? state.plan : d === state.tomorrow.date ? state.tomorrow.plan : null;
          const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : weekdayShort(d);
          const minutes = planned.reduce((a, t) => a + (t.estimateMinutes ?? 0), 0);
          const empty = !meetings.length && !planned.length && !due.length && !dayPlan;
          return (
            <section key={d} className={`week-day ${i === 0 ? "is-today" : ""}`}>
              <div className="week-date">
                <strong>{label}</strong>
                <span className="muted small">{dayNum(d)}</span>
                {minutes > 0 && <span className="muted small">{fmtDuration(minutes)} planned</span>}
              </div>
              <div className="week-items">
                {dayPlan && (
                  <button className="week-plan" onClick={() => onOpenDay(i === 0 ? "today" : "tomorrow")}>
                    <span className="tag">Plan</span> {dayPlan.mainOutcome || "Confirmed plan"} →
                  </button>
                )}
                {meetings.map((m) => (
                  <div key={m.id} className="week-item event">
                    <span className="agenda-dot" aria-hidden />
                    <span>
                      <span className="muted small">{fmtRange(m.start, m.end)} · </span>
                      {m.title}
                    </span>
                    <button className="icon-btn small-x" aria-label={`Delete ${m.title}`} onClick={() => confirm(`Delete “${m.title}”?`) && actions.mutate("DELETE", `/api/meetings/${m.id}`)}>
                      ×
                    </button>
                  </div>
                ))}
                {due.map((t) => (
                  <div key={`due-${t.id}`} className="week-item deadline">
                    <span className="agenda-dot" aria-hidden />
                    <span>
                      {t.title} <span className="tag warn">{t.deadline! < state.today ? "Overdue" : "Due"}</span>
                    </span>
                  </div>
                ))}
                {planned.map((t) => (
                  <div key={t.id} className="week-item task">
                    <input type="checkbox" className="check small" checked={t.status === "done"} onChange={(e) => complete(t, e.target.checked)} aria-label={`Mark ${t.title} done`} />
                    <span>
                      {t.title}
                      {t.plannedDate && t.plannedDate < state.today && <span className="tag subtle">from {fmtDate(t.plannedDate, false)}</span>}
                      {t.estimateMinutes ? <span className="muted small"> · {fmtDuration(t.estimateMinutes)}</span> : null}
                    </span>
                    <button className="icon-btn small-x" aria-label={`Unplan ${t.title}`} title="Remove from this day" onClick={() => setPlanned(t, null)}>
                      ×
                    </button>
                  </div>
                ))}
                {empty && <span className="muted small week-free">Free</span>}
              </div>
            </section>
          );
        })}
      </div>

      {unscheduled.length > 0 && (
        <div className="card">
          <h3 className="h3">Not scheduled yet ({unscheduled.length})</h3>
          <p className="muted small">Pick a day, or ask Nikki to spread them across the week.</p>
          <ul className="plain-list">
            {unscheduled.map((t) => (
              <li key={t.id} className="unscheduled-row">
                <span>
                  {t.title}
                  {t.deadline && <span className="tag warn">Due {fmtDate(t.deadline, false)}</span>}
                </span>
                <select className="small-select" value="" onChange={(e) => e.target.value && setPlanned(t, e.target.value)} aria-label={`Plan ${t.title} for a day`}>
                  <option value="">Do on…</option>
                  {days.map((d, i) => (
                    <option key={d} value={d}>
                      {i === 0 ? "Today" : i === 1 ? "Tomorrow" : `${weekdayShort(d)} ${dayNum(d)}`}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}

      <AddEvent state={state} actions={actions} />

      {laterItems.length > 0 && (
        <div className="card">
          <h3 className="h3">Later</h3>
          <ul className="plain-list compact">
            {laterItems.map((i) => (
              <li key={i.key} className={`agenda-item ${i.kind}`}>
                <span className="agenda-dot" aria-hidden />
                <span>
                  <span className="muted small">
                    {fmtDate(i.date)}
                    {i.time ? ` · ${i.time}` : ""} ·{" "}
                  </span>
                  {i.text}
                  {i.kind === "deadline" && <span className="tag warn">Due</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function AddEvent({ state, actions }: { state: AppState; actions: AppActions }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", date: "", start: "", end: "" });
  if (!open) {
    return (
      <button className="btn ghost add-event" onClick={() => setOpen(true)}>
        + Add a meeting or event
      </button>
    );
  }
  return (
    <form
      className="card meeting-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await actions.mutate("POST", "/api/meetings", form)) {
          setOpen(false);
          setForm({ title: "", date: "", start: "", end: "" });
        }
      }}
    >
      <input placeholder="What is it?" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-label="Title" />
      <input type="date" min={state.today} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} aria-label="Date" />
      <input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} aria-label="Start" />
      <input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} aria-label="End" />
      <button className="btn small primary" disabled={!form.title || !form.date || !form.start || !form.end}>
        Add
      </button>
      <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}
