import { useEffect, useState } from "react";
import type { AppState, Task, TaskDraft } from "../../shared/types";
import { api, ApiError } from "../api";
import type { AppActions } from "../App";
import { fmtDuration } from "../util";

/** Minutes on the focus timer, including the currently running stretch. Re-renders every 30s. */
export function useTimerMinutes(task: Task) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!task.timerStartedAt) return;
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [task.timerStartedAt]);
  const running = task.timerStartedAt ? Math.max(0, Math.round((Date.now() - new Date(task.timerStartedAt).getTime()) / 60000)) : 0;
  return task.spentMinutes + running;
}

export function TimerButton({ task, actions }: { task: Task; actions: AppActions }) {
  const minutes = useTimerMinutes(task);
  const running = !!task.timerStartedAt;
  return (
    <button
      className={`btn small ${running ? "timer-on" : "ghost"}`}
      onClick={() => actions.mutate("POST", `/api/tasks/${task.id}/timer`, { action: running ? "stop" : "start" })}
      aria-pressed={running}
      title="Tracks how long this really takes, so Nikki's estimates get better"
    >
      {running ? `Pause · ${fmtDuration(minutes)}` : minutes > 0 ? `Resume · ${fmtDuration(minutes)}` : "Start focus timer"}
    </button>
  );
}

export function TaskToolButtons({ task, actions, timer = false }: { task: Task; actions: AppActions; timer?: boolean }) {
  return (
    <div className="task-tools">
      {timer && task.status === "open" && <TimerButton task={task} actions={actions} />}
      <button className="btn small ghost" onClick={() => actions.openHelper(task.id, "breakdown")}>
        {task.steps.length ? "Redo steps" : "Break it down"}
      </button>
      <button className="btn small ghost" onClick={() => actions.openHelper(task.id, "assist")}>
        Help me start
      </button>
    </div>
  );
}

export function StepList({ task, actions, compact = false }: { task: Task; actions: AppActions; compact?: boolean }) {
  if (!task.steps.length) return null;
  const done = task.steps.filter((s) => s.done).length;
  const list = (
    <ul className="steps">
      {task.steps.map((s) => (
        <li key={s.id} className={s.done ? "done" : ""}>
          <label>
            <input
              type="checkbox"
              className="check small"
              checked={s.done}
              onChange={(e) => actions.mutate("PATCH", `/api/steps/${s.id}`, { done: e.target.checked })}
            />
            <span>{s.title}</span>
            {s.minutes ? <span className="muted small">{fmtDuration(s.minutes)}</span> : null}
          </label>
        </li>
      ))}
    </ul>
  );
  if (compact) {
    return (
      <details className="steps-wrap">
        <summary>
          Steps {done}/{task.steps.length}
        </summary>
        {list}
      </details>
    );
  }
  return (
    <div className="steps-wrap">
      <div className="muted small">
        Steps · {done} of {task.steps.length} done
      </div>
      {list}
    </div>
  );
}

// ---------- the helper window ----------

type EditStep = { id?: string; title: string; minutes: number | null };

export function TaskHelper({
  state,
  actions,
  taskId,
  mode,
  onClose,
}: {
  state: AppState;
  actions: AppActions;
  taskId: string;
  mode: "breakdown" | "assist";
  onClose: () => void;
}) {
  const task = state.tasks.find((t) => t.id === taskId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!task) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={mode === "breakdown" ? "Break it down" : "Help me start"} onClick={(e) => e.stopPropagation()}>
        <div className="row between center-y">
          <div>
            <div className="eyebrow">{mode === "breakdown" ? "Break it down" : "Help me start"}</div>
            <h3 className="h3 modal-title">{task.title}</h3>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {mode === "breakdown" ? (
          <Breakdown task={task} state={state} actions={actions} onClose={onClose} />
        ) : (
          <Assist task={task} state={state} actions={actions} />
        )}
      </div>
    </div>
  );
}

function Breakdown({ task, state, actions, onClose }: { task: Task; state: AppState; actions: AppActions; onClose: () => void }) {
  const [steps, setSteps] = useState<EditStep[] | null>(task.steps.length ? task.steps.map((s) => ({ ...s })) : null);
  const [note, setNote] = useState("");
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = state.workspace === "personal";

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ steps: EditStep[]; note: string; demo: boolean }>("POST", `/api/tasks/${task.id}/breakdown`, {});
      setSteps(r.steps);
      setNote(r.note);
      setDemo(r.demo);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!task.steps.length) generate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!steps) return;
    const clean = steps.filter((s) => s.title.trim()).map((s) => ({ id: s.id, title: s.title.trim(), minutes: s.minutes && s.minutes > 0 ? Math.round(s.minutes) : null }));
    const ok = await actions.mutate("PUT", `/api/tasks/${task.id}/steps`, { steps: clean });
    if (ok) {
      actions.toast({ text: `Saved ${clean.length} steps for “${task.title}”.` });
      onClose();
    }
  };

  const total = (steps ?? []).reduce((a, s) => a + (s.minutes ?? 0), 0);

  return (
    <div className="helper-body">
      {loading && (
        <div className="working">
          <span className="typing inline">
            <span />
            <span />
            <span />
          </span>
          {live ? "Nikki is breaking this down…" : "Building steps from a template…"}
        </div>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}{" "}
          <button className="btn small" onClick={generate}>
            Try again
          </button>
        </div>
      )}
      {steps && !loading && (
        <>
          {demo && <div className="demo-tag">Demo · template steps, not AI</div>}
          {note && <p className="muted small">{note}</p>}
          <ol className="step-edit">
            {steps.map((s, i) => (
              <li key={i}>
                <input
                  value={s.title}
                  aria-label={`Step ${i + 1}`}
                  onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                />
                <input
                  type="number"
                  min={1}
                  className="mins"
                  value={s.minutes ?? ""}
                  aria-label={`Minutes for step ${i + 1}`}
                  placeholder="min"
                  onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, minutes: e.target.value ? Number(e.target.value) : null } : x)))}
                />
                <button className="icon-btn" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                  ×
                </button>
              </li>
            ))}
          </ol>
          <div className="row between center-y wrap gap">
            <button className="btn small ghost" onClick={() => setSteps([...steps, { title: "", minutes: null }])}>
              + Add step
            </button>
            {total > 0 && <span className="muted small">About {fmtDuration(total)} in total</span>}
          </div>
          <div className="row gap wrap">
            <button className="btn primary" onClick={save} disabled={!steps.some((s) => s.title.trim())}>
              Save steps
            </button>
            <button className="btn ghost" onClick={generate}>
              {live ? "Ask Nikki again" : "Regenerate"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const FORMAT_LABEL: Record<string, string> = {
  email: "Email",
  message: "Message",
  outline: "Outline",
  checklist: "Checklist",
  social_post: "Social post",
  plan: "Plan",
  notes: "Notes",
};

function Assist({ task, state, actions }: { task: Task; state: AppState; actions: AppActions }) {
  const [ask, setAsk] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drafts = state.drafts.filter((d) => d.taskId === task.id);
  const live = state.workspace === "personal";

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ state: AppState; draft: TaskDraft }>("POST", `/api/tasks/${task.id}/assist`, { ask });
      actions.setState(r.state);
      setAsk("");
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="helper-body">
      <form
        className="row gap wrap"
        onSubmit={(e) => {
          e.preventDefault();
          generate();
        }}
      >
        <input
          className="grow"
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          placeholder="What would help? (optional) e.g. “an email asking the client for feedback”"
          aria-label="What would help"
        />
        <button className="btn primary" disabled={loading}>
          {drafts.length ? "New draft" : "Draft it for me"}
        </button>
      </form>
      {!live && <p className="muted small">Demo mode drafts come from a template, not AI.</p>}
      {loading && (
        <div className="working">
          <span className="typing inline">
            <span />
            <span />
            <span />
          </span>
          {live ? "Nikki is drafting…" : "Filling in a template…"}
        </div>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {drafts.map((d) => (
        <DraftCard key={d.id} draft={d} actions={actions} />
      ))}
    </div>
  );
}

function DraftCard({ draft, actions }: { draft: TaskDraft; actions: AppActions }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="draft">
      <div className="row between center-y wrap gap">
        <div>
          {draft.demo && <div className="demo-tag">Demo · template, not AI</div>}
          <span className="tag subtle">{FORMAT_LABEL[draft.format] ?? draft.format}</span> <strong>{draft.title}</strong>
        </div>
        <div className="row gap">
          <button
            className="btn small"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(draft.content);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                actions.toast({ text: "Couldn't copy automatically — select the text and copy it.", tone: "error" });
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="btn small ghost" onClick={() => actions.mutate("DELETE", `/api/drafts/${draft.id}`)}>
            Delete
          </button>
        </div>
      </div>
      <pre className="draft-content">{draft.content}</pre>
      {draft.nextStep && (
        <p className="small">
          <strong>Next step:</strong> {draft.nextStep}
        </p>
      )}
    </div>
  );
}
