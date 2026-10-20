import { useState } from "react";
import type { AppState, Task } from "../../shared/types";
import { api, ApiError } from "../api";
import type { AppActions } from "../App";
import { fmtDate, fmtDuration } from "../util";
import { DecisionRow, type MoveChoice } from "./MoveSheet";

type WrapAction = "tomorrow" | "done" | "someday" | "drop";
const WRAP_LABELS: Record<WrapAction, string> = { tomorrow: "Tomorrow", done: "Done", someday: "Someday", drop: "Delete" };
const WRAP_TO_MOVE: Record<WrapAction, MoveChoice> = { tomorrow: "tomorrow", done: "done", someday: "someday", drop: "drop" };

function isToday(iso: string, tz: string, today: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)) === today;
  } catch {
    return iso.slice(0, 10) === today;
  }
}

export function doneTodayTasks(state: AppState) {
  const inPlan = new Set(state.plan?.blocks.map((b) => b.taskId).filter(Boolean));
  return state.tasks.filter(
    (t) => t.status === "done" && (inPlan.has(t.id) || (t.completedAt != null && isToday(t.completedAt, state.timezone, state.today))),
  );
}

/** Open work from today's plan (or the main focus/supporting picks). */
function unfinishedToday(state: AppState): Task[] {
  const ids = new Set<string>();
  for (const b of state.plan?.blocks ?? []) if (b.taskId) ids.add(b.taskId);
  if (state.plan?.focusTaskId) ids.add(state.plan.focusTaskId);
  state.plan?.supporting.forEach((s) => ids.add(s.taskId));
  return state.tasks.filter((t) => ids.has(t.id) && t.status !== "done");
}

// ---------- evening wrap-up ----------

export function WrapUpPanel({ state, actions, onClose, busy }: { state: AppState; actions: AppActions; onClose: () => void; busy: boolean }) {
  const done = doneTodayTasks(state);
  const open = unfinishedToday(state);
  const [decisions, setDecisions] = useState<Record<string, WrapAction>>(Object.fromEntries(open.map((t) => [t.id, "tomorrow"])));
  const [note, setNote] = useState(state.wrapUpToday?.note ?? "");
  const [reflect, setReflect] = useState(state.workspace === "demo" || state.liveAvailable);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canReflect = state.workspace === "demo" || state.liveAvailable;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api("POST", "/api/wrapup", {
        decisions: Object.entries(decisions).map(([taskId, action]) => ({ taskId, action })),
        note,
      });
      actions.setState(r.state);
      onClose();
      if (reflect && canReflect) {
        const title = (id: string) => r.state.tasks.find((t) => t.id === id)?.title ?? state.tasks.find((t) => t.id === id)?.title;
        const doneTitles = r.state.wrapUpToday?.doneTitles ?? [];
        const tomorrow = Object.entries(decisions)
          .filter(([, a]) => a === "tomorrow")
          .map(([id]) => title(id))
          .filter(Boolean);
        const text = [
          "Evening wrap-up.",
          doneTitles.length ? `Done today: ${doneTitles.join(", ")}` : "Nothing marked done today.",
          tomorrow.length ? `Moving to tomorrow: ${tomorrow.join(", ")}` : "",
          note.trim() ? `On my mind: ${note.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        actions.focusComposer();
        await actions.send(text, "wrapup");
      } else {
        actions.toast({ text: "Day wrapped up. See you tomorrow." });
      }
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card wrapup">
      <h3 className="h3">Wrap up</h3>

      <div className="wrap-section">
        <div className="eyebrow">Done today ({done.length})</div>
        {done.length ? (
          <ul className="plain-list compact">
            {done.map((t) => (
              <li key={t.id} className="struck">
                {t.title}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Nothing marked done.</p>
        )}
      </div>

      {open.length > 0 && (
        <div className="wrap-section">
          <div className="eyebrow">Still open</div>
          <p className="muted small">These move to tomorrow unless you change them.</p>
          <ul className="plain-list decisions">
            {open.map((t) => (
              <DecisionRow
                key={t.id}
                title={t.title}
                value={decisions[t.id]}
                labels={WRAP_LABELS}
                choices={["tomorrow", "someday", "done", "drop"]}
                toMove={WRAP_TO_MOVE}
                minDate={state.today}
                onChange={(a) => setDecisions({ ...decisions, [t.id]: a })}
              />
            ))}
          </ul>
        </div>
      )}

      <label className="field">
        <span>Notes for tomorrow (optional)</span>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      {canReflect && (
        <label className="check-row">
          <input type="checkbox" checked={reflect} onChange={(e) => setReflect(e.target.checked)} />
          <span>
            Send a summary to Nikki{" "}
            <span className="muted small">{state.workspace === "demo" ? "(scripted in Demo mode)" : "(one AI message)"}</span>
          </span>
        </label>
      )}

      {error && <div className="error-box">{error}</div>}
      <div className="row gap wrap">
        <button className="btn primary" onClick={submit} disabled={saving || busy}>
          {saving ? "Saving…" : "Wrap up"}
        </button>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function WrappedUpNote({ state, onEdit }: { state: AppState; onEdit: () => void }) {
  const w = state.wrapUpToday!;
  return (
    <div className="card wrapped">
      <div className="row between center-y wrap gap">
        <div>
          <div className="eyebrow">Wrapped up</div>
          <span className="small">
            {w.doneTitles.length} done{w.tomorrowTaskIds.length ? ` · ${w.tomorrowTaskIds.length} moving to tomorrow` : ""}
          </span>
        </div>
        <button className="btn small ghost" onClick={onEdit}>
          Edit wrap-up
        </button>
      </div>
    </div>
  );
}

// ---------- morning check-in ----------

export function MorningCheckIn({ state, actions }: { state: AppState; actions: AppActions }) {
  const w = state.lastWrapUp!;
  const carried = w.tomorrowTaskIds.map((id) => state.tasks.find((t) => t.id === id)).filter((t): t is Task => !!t && t.status !== "done");
  return (
    <div className="card checkin">
      <h3 className="h3">Check-in</h3>
      <p className="small">
        {fmtDate(w.date)}: {w.doneTitles.length ? <>done — <strong>{w.doneTitles.join(", ")}</strong></> : "nothing marked done"}.
      </p>
      {carried.length > 0 && (
        <p className="small">
          Carrying over: <strong>{carried.map((t) => t.title).join(", ")}</strong>
        </p>
      )}
      {w.note && <p className="muted small">Your note: “{w.note}”</p>}
      <button
        className="btn primary"
        onClick={() =>
          actions.focusComposer(
            `Morning check-in.${carried.length ? ` Carrying over: ${carried.map((t) => t.title).join(", ")}.` : ""} Today I can work from `,
          )
        }
      >
        Plan today
      </button>
    </div>
  );
}

// ---------- how long did it really take? ----------

export function ActualTime({ task, actions }: { task: Task; actions: AppActions }) {
  const [custom, setCustom] = useState("");
  if (task.actualMinutes) {
    return (
      <span className="muted small">
        took {fmtDuration(task.actualMinutes)}
        {task.estimateMinutes ? ` · est. ${fmtDuration(task.estimateMinutes)}` : ""}
      </span>
    );
  }
  const save = (m: number) => actions.mutate("PATCH", `/api/tasks/${task.id}`, { actualMinutes: m });
  return (
    <span className="actual-ask">
      <span className="muted small">How long did it take?</span>
      {task.estimateMinutes ? (
        <button className="chip small-chip" onClick={() => save(task.estimateMinutes!)}>
          As planned ({fmtDuration(task.estimateMinutes)})
        </button>
      ) : null}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const v = Math.round(Number(custom));
          if (v > 0) save(v);
        }}
      >
        <input type="number" min={1} placeholder="min" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label={`Minutes ${task.title} took`} />
        <button className="btn small" disabled={!(Number(custom) > 0)}>
          Save
        </button>
      </form>
    </span>
  );
}
