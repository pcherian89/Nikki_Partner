import { useState } from "react";
import type { AppState, Task, TaskStatus, TaskType } from "../../shared/types";
import type { AppActions } from "../App";
import { fmtDuration } from "../util";
import { useCompletion } from "./Today";
import { StepList, TaskToolButtons } from "./TaskTools";
import { ActualTime } from "./DayRhythm";

export function Everything({ state, actions }: { state: AppState; actions: AppActions }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<TaskType>("action");
  const complete = useCompletion(state, actions);
  const live = state.tasks;

  const sections: { key: string; title: string; hint: string; items: Task[] }[] = [
    { key: "active", title: "Active actions", hint: "Things to do.", items: live.filter((t) => t.type === "action" && t.status === "open") },
    { key: "waiting", title: "Waiting or blocked", hint: "Can't move until something else happens.", items: live.filter((t) => t.status === "waiting" || t.status === "blocked") },
    { key: "ideas", title: "Parked ideas", hint: "Possibilities — not obligations. Promote one when you're ready.", items: live.filter((t) => t.type === "idea" && t.status === "open") },
    { key: "reference", title: "Reference", hint: "Information worth keeping.", items: live.filter((t) => t.type === "reference" && t.status === "open") },
    { key: "done", title: "Completed", hint: "", items: live.filter((t) => t.status === "done").reverse() },
  ];

  const add = async () => {
    if (!title.trim()) return;
    const ok = await actions.mutate("POST", "/api/tasks", { title: title.trim(), type });
    if (ok) setTitle("");
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h2">Everything</h1>
        <p className="muted">All your actions, ideas and notes in one place. Changes here don't call the AI.</p>
      </div>
      <form
        className="card add-row"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input placeholder="Add something…" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New item title" />
        <select value={type} onChange={(e) => setType(e.target.value as TaskType)} aria-label="Item type">
          <option value="action">Action</option>
          <option value="idea">Idea</option>
          <option value="reference">Reference</option>
        </select>
        <button className="btn primary" disabled={!title.trim()}>
          Add
        </button>
      </form>

      {sections.map((s) => (
        <section key={s.key} className="card list-section">
          {s.key === "done" ? (
            <details>
              <summary className="h3">
                {s.title} ({s.items.length})
              </summary>
              <TaskList items={s.items} state={state} actions={actions} onToggle={complete} />
            </details>
          ) : (
            <>
              <h2 className="h3">
                {s.title} <span className="muted">({s.items.length})</span>
              </h2>
              {s.hint && <p className="muted small">{s.hint}</p>}
              {s.items.length ? <TaskList items={s.items} state={state} actions={actions} onToggle={complete} /> : <p className="muted small">Nothing here.</p>}
            </>
          )}
        </section>
      ))}
    </div>
  );
}

function TaskList({ items, state, actions, onToggle }: { items: Task[]; state: AppState; actions: AppActions; onToggle: (t: Task, d: boolean) => void }) {
  return (
    <ul className="task-list">
      {items.map((t) => (
        <TaskRow key={t.id} task={t} state={state} actions={actions} onToggle={onToggle} />
      ))}
    </ul>
  );
}

function TaskRow({ task, state, actions, onToggle }: { task: Task; state: AppState; actions: AppActions; onToggle: (t: Task, d: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [estimate, setEstimate] = useState("");
  const [f, setF] = useState({
    title: task.title,
    notes: task.notes,
    estimate: task.estimateMinutes ? String(task.estimateMinutes) : "",
    deadline: task.deadline ?? "",
    project: task.project ?? "",
  });
  const inPlan = state.plan?.blocks.some((b) => b.taskId === task.id);

  const save = async () => {
    const ok = await actions.mutate("PATCH", `/api/tasks/${task.id}`, {
      title: f.title.trim(),
      notes: f.notes,
      estimateMinutes: f.estimate ? Math.max(1, Math.round(Number(f.estimate))) : null,
      deadline: f.deadline || null,
      project: f.project.trim() || null,
    });
    if (ok) setEditing(false);
  };

  return (
    <li className={`task-row ${task.status === "done" ? "done" : ""}`}>
      <div className="task-main">
        {task.type === "action" || task.status === "done" ? (
          <input type="checkbox" className="check" checked={task.status === "done"} onChange={(e) => onToggle(task, e.target.checked)} aria-label={`Mark ${task.title} done`} />
        ) : (
          <span className={`type-dot ${task.type}`} aria-hidden />
        )}
        <div className="task-text">
          <span className="slot-title">{task.title}</span>
          <span className="task-meta">
            {task.project && <span className="tag subtle">{task.project}</span>}
            {task.estimateMinutes ? <span className="muted small">{fmtDuration(task.estimateMinutes)}</span> : null}
            {task.deadline && <span className="tag warn">Due {task.deadline}</span>}
            {inPlan && <span className="tag">In today's plan</span>}
            {task.status === "blocked" && <span className="tag warn">Blocked</span>}
            {task.status === "waiting" && <span className="tag subtle">Waiting</span>}
          </span>
          {task.notes && !editing && <span className="muted small block">{task.notes}</span>}
          <StepList task={task} actions={actions} compact />
          {task.status === "done" && task.type === "action" && <ActualTime task={task} actions={actions} />}
          {task.type === "action" && task.status !== "done" && <TaskToolButtons task={task} actions={actions} />}
          {state.drafts.some((d) => d.taskId === task.id) && (
            <button className="link small" onClick={() => actions.openHelper(task.id, "assist")}>
              View drafts ({state.drafts.filter((d) => d.taskId === task.id).length})
            </button>
          )}
        </div>
        <div className="row gap task-actions">
          {task.type === "idea" && task.status === "open" && (
            <button className="btn small" onClick={() => setPromoting((p) => !p)}>
              Make it an action
            </button>
          )}
          {task.status !== "done" && (
            <select
              className="small-select"
              value={task.status}
              aria-label="Status"
              onChange={(e) => actions.mutate("PATCH", `/api/tasks/${task.id}`, { status: e.target.value as TaskStatus })}
            >
              <option value="open">Open</option>
              <option value="waiting">Waiting</option>
              <option value="blocked">Blocked</option>
              <option value="done">Done</option>
            </select>
          )}
          <button className="btn small ghost" onClick={() => setEditing((e) => !e)}>
            Edit
          </button>
          <button
            className="btn small ghost"
            onClick={() => {
              if (confirm(`Delete “${task.title}”?${inPlan ? " It will also be removed from today's plan." : ""}`)) actions.mutate("DELETE", `/api/tasks/${task.id}`);
            }}
          >
            Delete
          </button>
        </div>
      </div>
      {promoting && (
        <form
          className="promote"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await actions.mutate("PATCH", `/api/tasks/${task.id}`, {
              type: "action",
              status: "open",
              estimateMinutes: estimate ? Math.max(1, Math.round(Number(estimate))) : null,
            });
            if (ok) {
              setPromoting(false);
              actions.toast({ text: `“${task.title}” is now an action. Nikki will consider it next time you plan.` });
            }
          }}
        >
          <span className="small">Turn this idea into a concrete action. Roughly how long is the first step?</span>
          <input type="number" min={5} step={5} placeholder="minutes" value={estimate} onChange={(e) => setEstimate(e.target.value)} aria-label="Estimate in minutes" />
          <button className="btn small primary">Promote</button>
          <button type="button" className="btn small ghost" onClick={() => setPromoting(false)}>
            Cancel
          </button>
        </form>
      )}
      {editing && (
        <form
          className="task-edit"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="field">
            <span>Title</span>
            <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </label>
          <div className="grid-3">
            <label className="field">
              <span>Estimate (min)</span>
              <input type="number" min={1} value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value })} />
            </label>
            <label className="field">
              <span>Deadline (only if real)</span>
              <input type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} />
            </label>
            <label className="field">
              <span>Project</span>
              <input value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>Notes</span>
            <textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </label>
          <div className="row gap">
            <button className="btn small primary" disabled={!f.title.trim()}>
              Save
            </button>
            <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
