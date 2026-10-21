import { useMemo, useState } from "react";
import type { AppState, ProjectDraft, ProjectView, Task } from "../../shared/types";
import type { AppActions } from "../App";
import { fmtDate, fmtDuration } from "../util";
import { ActionSheet } from "./MoveSheet";
import { AddTask, TaskRow, useTimerControls } from "./TaskList";
import { useCompletion } from "./Today";

const STATUS_LABEL: Record<string, string> = { active: "Active", paused: "Paused", completed: "Completed", archived: "Archived" };

export function progressText(p: ProjectView) {
  const g = p.progress;
  const parts = [`${g.tasksDone} of ${g.tasksTotal} task${g.tasksTotal === 1 ? "" : "s"} done`];
  if (g.milestonesTotal) parts.push(`${g.milestonesDone} of ${g.milestonesTotal} milestones`);
  if (g.workedMinutes) parts.push(`${fmtDuration(g.workedMinutes)} recorded`);
  return parts.join(" · ");
}

/** The list of projects, at the top of Everything. Small on purpose: one line per project. */
export function ProjectsSection({ state, actions, onOpen }: { state: AppState; actions: AppActions; onOpen: (id: string) => void }) {
  const live = state.projects.filter((p) => p.status === "active" || p.status === "paused");
  const rest = state.projects.filter((p) => p.status === "completed" || p.status === "archived");
  const row = (p: ProjectView) => (
    <li key={p.id}>
      <button className="project-row" onClick={() => onOpen(p.id)}>
        <span className="project-row-main">
          <strong>{p.title}</strong>
          {p.status !== "active" && <span className="tag subtle">{STATUS_LABEL[p.status]}</span>}
          {p.progress.overdueMilestoneIds.length > 0 && <span className="tag warn">Milestone overdue</span>}
        </span>
        <span className="muted small">{progressText(p)}</span>
      </button>
    </li>
  );
  return (
    <section className="card list-section projects-card" aria-label="Projects">
      <div className="row between center-y">
        <h2 className="h3">
          Projects <span className="muted">({live.length})</span>
        </h2>
        <button className="btn small" onClick={() => actions.focusComposer("I want to plan a project: ")}>
          + New project
        </button>
      </div>
      {live.length ? <ul className="plain-list project-list">{live.map(row)}</ul> : <p className="muted small">No projects yet. Tell Nikki about a goal that will take weeks or months and she’ll propose a plan.</p>}
      {rest.length > 0 && (
        <details>
          <summary className="section-summary">Completed and archived ({rest.length})</summary>
          <ul className="plain-list project-list">{rest.map(row)}</ul>
        </details>
      )}
    </section>
  );
}

export function ProjectPage({ state, actions, projectId, onBack }: { state: AppState; actions: AppActions; projectId: string; onBack: () => void }) {
  const p = state.projects.find((x) => x.id === projectId);
  const timers = useTimerControls(state, actions);
  const complete = useCompletion(state, actions);
  const [menu, setMenu] = useState(false);
  const tasks = useMemo(() => state.tasks.filter((t) => t.projectId === projectId && t.type === "action"), [state.tasks, projectId]);
  if (!p) {
    return (
      <div className="page">
        <button className="btn ghost" onClick={onBack}>
          ← Projects
        </button>
        <p className="muted">That project no longer exists.</p>
      </div>
    );
  }
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const next = p.progress.nextActionIds.map((id) => byId.get(id)).filter(Boolean) as Task[];
  const open = (t: Task) => t.status !== "done";
  const setStatus = (status: string) => actions.mutate("POST", `/api/projects/${p.id}/status`, { status });
  const row = (t: Task) => <TaskRow key={t.id} task={t} state={state} actions={actions} timers={timers} plan={null} onToggle={complete} isToday={false} />;
  const loose = tasks.filter((t) => !t.milestoneId);

  return (
    <div className="page project-page">
      <div className="row between center-y">
        <button className="btn ghost small" onClick={onBack}>
          ← Projects
        </button>
        <button className="icon-btn" aria-label="Project options" onClick={() => setMenu(true)}>
          ⋯
        </button>
      </div>
      <div className="page-head">
        <h1 className="h2">{p.title}</h1>
        <div className="row gap wrap center-y">
          <span className={`tag ${p.status === "active" ? "" : "subtle"}`}>{STATUS_LABEL[p.status]}</span>
          {p.targetDate && <span className="muted small">Target {fmtDate(p.targetDate)}</span>}
        </div>
        {p.goal && <p className="small">{p.goal}</p>}
        <p className="muted small">{progressText(p)}</p>
      </div>

      {p.status === "active" && (
        <section className="card">
          <h3 className="h3">Next actions</h3>
          {next.length ? (
            <ul className="task-list">{next.map(row)}</ul>
          ) : (
            <p className="muted small">{p.progress.tasksTotal ? "Nothing open. Ask Nikki for the next steps." : "No tasks yet."}</p>
          )}
          <p className="muted small">These don’t appear on Today until you add them.</p>
        </section>
      )}
      {p.status !== "active" && <p className="muted small">This project is {p.status}. Its tasks stay saved but nothing is suggested.</p>}

      <section className="card">
        <h3 className="h3">Milestones</h3>
        {p.milestones.length === 0 && <p className="muted small">No milestones.</p>}
        <ul className="plain-list milestone-list">
          {p.milestones.map((m) => {
            const mine = tasks.filter((t) => t.milestoneId === m.id);
            const done = mine.filter((t) => t.status === "done").length;
            const overdue = m.status === "open" && m.targetDate && m.targetDate < state.today;
            return (
              <li key={m.id} className={`milestone ${m.status}`}>
                <div className="row between center-y wrap gap">
                  <span>
                    <strong className={m.status === "done" ? "struck" : ""}>{m.title}</strong>
                    {m.targetDate && <span className="muted small"> · {fmtDate(m.targetDate, false)}</span>}
                    {overdue && <span className="tag warn">Overdue</span>}
                    {mine.length > 0 && (
                      <span className="muted small">
                        {" "}
                        · {done}/{mine.length} tasks
                      </span>
                    )}
                  </span>
                  <button className="btn small ghost" onClick={() => actions.mutate("POST", `/api/milestones/${m.id}/status`, { status: m.status === "done" ? "open" : "done" })}>
                    {m.status === "done" ? "Reopen" : "Mark done"}
                  </button>
                </div>
                {mine.some(open) && (
                  <details>
                    <summary className="section-summary">Open tasks ({mine.filter(open).length})</summary>
                    <ul className="task-list">{mine.filter(open).map(row)}</ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
        {loose.some(open) && (
          <details>
            <summary className="section-summary">Not in a milestone ({loose.filter(open).length})</summary>
            <ul className="task-list">{loose.filter(open).map(row)}</ul>
          </details>
        )}
        {p.status !== "archived" && <AddTask actions={actions} plannedDate={null} projectId={p.id} placeholder="+ Add a task to this project" />}
      </section>

      {(p.assumptions.length > 0 || p.dependencies.length > 0) && (
        <details className="card">
          <summary className="section-summary">Assumptions and dependencies</summary>
          {p.assumptions.length > 0 && (
            <>
              <div className="eyebrow">Assumptions</div>
              <ul>{p.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
            </>
          )}
          {p.dependencies.length > 0 && (
            <>
              <div className="eyebrow">Depends on</div>
              <ul>{p.dependencies.map((a) => <li key={a}>{a}</li>)}</ul>
            </>
          )}
        </details>
      )}

      {menu && (
        <ActionSheet
          title={p.title}
          onClose={() => setMenu(false)}
          items={[
            { label: "Ask Nikki to adjust the plan…", run: () => actions.focusComposer(`About the project “${p.title}”: `) },
            ...(p.status === "active" ? [{ label: "Pause project", run: () => setStatus("paused") }] : []),
            ...(p.status === "paused" || p.status === "archived" || p.status === "completed" ? [{ label: "Resume project", run: () => setStatus("active") }] : []),
            ...(p.status !== "completed" && p.status !== "archived" ? [{ label: "Mark project complete", run: () => setStatus("completed") }] : []),
            ...(p.status !== "archived" ? [{ label: "Archive project", run: () => setStatus("archived") }] : []),
          ]}
        />
      )}
    </div>
  );
}

/** What a proposed project (or a change to one) contains, for the Confirm card. */
export function ProjectPlanPreview({ draft, state }: { draft: ProjectDraft; state: AppState }) {
  const existing = draft.projectId ? state.projects.find((p) => p.id === draft.projectId) : null;
  const msTitle = (ref: string | null) => draft.milestones.find((m) => m.ref === ref)?.title ?? existing?.milestones.find((m) => m.id === ref)?.title ?? null;
  return (
    <div className="project-preview">
      <div className="eyebrow">{existing ? "Change to project" : "New project"}</div>
      <strong className="project-preview-title">{draft.title}</strong>
      {draft.goal && <p className="small">{draft.goal}</p>}
      {draft.targetDate && (
        <p className="small">
          Target: {fmtDate(draft.targetDate)}
          {existing?.targetDate && existing.targetDate !== draft.targetDate ? <span className="muted"> (was {fmtDate(existing.targetDate)})</span> : null}
        </p>
      )}
      {draft.milestones.length > 0 && (
        <div>
          <div className="eyebrow">Milestones</div>
          <ol className="project-preview-list">
            {draft.milestones.map((m) => {
              const was = m.id ? existing?.milestones.find((x) => x.id === m.id) : null;
              return (
                <li key={m.ref} className={m.remove ? "struck" : ""}>
                  {m.remove ? "Remove: " : !m.id ? "New: " : was && (was.title !== m.title || was.targetDate !== m.targetDate) ? "Change: " : ""}
                  {m.title}
                  {m.targetDate && <span className="muted small"> · {fmtDate(m.targetDate, false)}</span>}
                  {was && was.targetDate !== m.targetDate && !m.remove && was.targetDate && <span className="muted small"> (was {fmtDate(was.targetDate, false)})</span>}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {draft.tasks.length > 0 && (
        <div>
          <div className="eyebrow">Tasks ({draft.tasks.length}) · not added to Today</div>
          <ul className="project-preview-list">
            {draft.tasks.map((t) => (
              <li key={t.ref}>
                {t.title}
                {t.priority === "high" && <span className="tag">High</span>}
                {msTitle(t.milestoneRef) && <span className="muted small"> · {msTitle(t.milestoneRef)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {draft.assumptions.length > 0 && (
        <details>
          <summary className="section-summary">Assumptions ({draft.assumptions.length})</summary>
          <ul>{draft.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </details>
      )}
      {draft.dependencies.length > 0 && (
        <details>
          <summary className="section-summary">Depends on ({draft.dependencies.length})</summary>
          <ul>{draft.dependencies.map((a) => <li key={a}>{a}</li>)}</ul>
        </details>
      )}
      {draft.reason && <p className="muted small">{draft.reason}</p>}
    </div>
  );
}
