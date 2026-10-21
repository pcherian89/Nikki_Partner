import { useState } from "react";
import type { AppState, Task, TaskPriority, TaskStatus, TaskType } from "../../shared/types";
import type { AppActions } from "../App";
import { fmtDuration } from "../util";
import { useCompletion, useMoveTask } from "./Today";
import { StepList } from "./TaskTools";
import { ActionSheet, MoveSheet } from "./MoveSheet";
import { ActualTime } from "./DayRhythm";
import { AutoTextarea } from "./AutoTextarea";
import { dueLabel } from "./TaskList";
import { ProjectPage, ProjectsSection } from "./Projects";

export function Everything({ state, actions }: { state: AppState; actions: AppActions }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<TaskType>("action");
  const complete = useCompletion(state, actions);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const live = state.tasks;

  const sections: { key: string; title: string; hint: string; items: Task[] }[] = [
    { key: "active", title: "Actions", hint: "", items: live.filter((t) => t.type === "action" && t.status === "open") },
    { key: "waiting", title: "Waiting", hint: "", items: live.filter((t) => t.status === "waiting" || t.status === "blocked") },
    { key: "ideas", title: "Ideas", hint: "", items: live.filter((t) => t.type === "idea" && t.status === "open") },
    { key: "reference", title: "Reference", hint: "", items: live.filter((t) => t.type === "reference" && t.status === "open") },
    { key: "done", title: "Done", hint: "", items: live.filter((t) => t.status === "done").reverse() },
  ];

  const add = async () => {
    if (!title.trim()) return;
    const ok = await actions.mutate("POST", "/api/tasks", { title: title.trim(), type });
    if (ok) setTitle("");
  };

  if (openProject) return <ProjectPage state={state} actions={actions} projectId={openProject} onBack={() => setOpenProject(null)} />;

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h2">Everything</h1>
      </div>
      <ProjectsSection state={state} actions={actions} onOpen={setOpenProject} />
      <form
        className="card add-row"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <AutoTextarea placeholder="Add something…" value={title} onChange={setTitle} submitOnEnter aria-label="New item title" />
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
  const [sheet, setSheet] = useState<"actions" | "move" | null>(null);
  const move = useMoveTask(state, actions, onToggle);
  const [estimate, setEstimate] = useState("");
  const [f, setF] = useState({
    title: task.title,
    notes: task.notes,
    estimate: task.estimateMinutes ? String(task.estimateMinutes) : "",
    deadline: task.deadline ?? "",
    deadlineTime: task.deadlineTime ?? "",
    priority: task.priority,
    optional: task.optional,
    projectId: task.projectId ?? "",
    milestoneId: task.milestoneId ?? "",
    project: task.project ?? "",
  });
  const inPlan = state.plan?.blocks.some((b) => b.taskId === task.id);

  const save = async () => {
    const ok = await actions.mutate("PATCH", `/api/tasks/${task.id}`, {
      title: f.title.trim(),
      notes: f.notes,
      estimateMinutes: f.estimate ? Math.max(1, Math.round(Number(f.estimate))) : null,
      deadline: f.deadline || null,
      deadlineTime: f.deadline && f.deadlineTime ? f.deadlineTime : null,
      priority: f.priority,
      optional: f.optional,
      projectId: f.projectId || null,
      milestoneId: f.projectId ? f.milestoneId || null : null,
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
            {task.priority === "high" && <span className="tag">High</span>}
            {task.priority === "low" && <span className="muted small">Low priority</span>}
            {task.optional && <span className="tag subtle">If time allows</span>}
            {task.deadline && <span className="tag warn">{dueLabel(task, state.today)}</span>}
            {task.plannedDate && task.status !== "done" && <span className="muted small">{task.plannedDate === state.today ? "Today" : task.plannedDate === state.tomorrow.date ? "Tomorrow" : task.plannedDate}</span>}
            {inPlan && <span className="tag">Today</span>}
            {task.status === "blocked" && <span className="tag warn">Blocked</span>}
            {task.status === "waiting" && <span className="tag subtle">Waiting</span>}
          </span>
          {task.notes && !editing && <span className="muted small block">{task.notes}</span>}
          <StepList task={task} actions={actions} compact />
          {task.status === "done" && task.type === "action" && <ActualTime task={task} actions={actions} />}
          {state.drafts.some((d) => d.taskId === task.id) && (
            <button className="link small" onClick={() => actions.openHelper(task.id, "assist")}>
              View drafts ({state.drafts.filter((d) => d.taskId === task.id).length})
            </button>
          )}
        </div>
        <div className="task-actions">
          <button className="icon-btn" aria-label={`Actions for ${task.title}`} onClick={() => setSheet("actions")}>
            ⋯
          </button>
        </div>
      </div>
      {sheet === "actions" && (
        <ActionSheet
          title={task.title}
          onClose={() => setSheet(null)}
          items={[
            ...(task.type === "idea" && task.status === "open" ? [{ label: "Make it an action", run: () => setPromoting(true) }] : []),
            ...(task.type === "action" && task.status !== "done"
              ? [
                  { label: "Move…", run: () => setSheet("move") },
                  { label: "Break it down", run: () => actions.openHelper(task.id, "breakdown") },
                  { label: "Help me start", run: () => actions.openHelper(task.id, "assist") },
                ]
              : []),
            ...(task.status !== "done" && task.status !== "waiting"
              ? [{ label: "Mark waiting", run: () => actions.mutate("PATCH", `/api/tasks/${task.id}`, { status: "waiting" as TaskStatus }) }]
              : []),
            ...(task.status !== "done" && task.status !== "blocked"
              ? [{ label: "Mark blocked", run: () => actions.mutate("PATCH", `/api/tasks/${task.id}`, { status: "blocked" as TaskStatus }) }]
              : []),
            ...(task.status === "waiting" || task.status === "blocked"
              ? [{ label: "Back to open", run: () => actions.mutate("PATCH", `/api/tasks/${task.id}`, { status: "open" as TaskStatus }) }]
              : []),
            { label: "Edit", run: () => setEditing(true) },
            {
              label: "Delete",
              danger: true,
              run: () => {
                if (confirm(`Delete “${task.title}”?${inPlan ? " It will also be removed from today's plan." : ""}`)) actions.mutate("DELETE", `/api/tasks/${task.id}`);
              },
            },
          ]}
        />
      )}
      {sheet === "move" && (
        <MoveSheet
          title={task.title}
          choices={["today", "tomorrow", "pick", "someday"]}
          minDate={state.today}
          onClose={() => setSheet(null)}
          onPick={(c, d) => {
            setSheet(null);
            move(task, c, d);
          }}
        />
      )}
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
              actions.toast({ text: "Moved to actions." });
            }
          }}
        >
          <span className="small">First step (min)</span>
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
            <AutoTextarea value={f.title} onChange={(v) => setF({ ...f, title: v })} submitOnEnter />
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
              <span>Deadline time</span>
              <input type="time" value={f.deadlineTime} disabled={!f.deadline} onChange={(e) => setF({ ...f, deadlineTime: e.target.value })} />
            </label>
            <label className="field">
              <span>Priority</span>
              <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as TaskPriority })}>
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label className="field">
              <span>Project</span>
              <select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value, milestoneId: "" })}>
                <option value="">None</option>
                {state.projects.filter((p) => p.status !== "archived").map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
            {f.projectId && (
              <label className="field">
                <span>Milestone</span>
                <select value={f.milestoneId} onChange={(e) => setF({ ...f, milestoneId: e.target.value })}>
                  <option value="">None</option>
                  {state.projects.find((p) => p.id === f.projectId)?.milestones.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <label className="check-line">
            <input type="checkbox" checked={f.optional} onChange={(e) => setF({ ...f, optional: e.target.checked })} />
            <span>Only if time allows</span>
          </label>
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
