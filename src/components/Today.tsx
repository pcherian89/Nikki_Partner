import { useMemo, useState } from "react";
import type { AppState, Plan, PlanBlock, Task } from "../../shared/types";
import { api, ApiError } from "../api";
import type { AppActions } from "../App";
import { ProposalCard } from "./ProposalCard";
import { ActualTime, doneTodayTasks, MorningCheckIn, WrappedUpNote, WrapUpPanel } from "./DayRhythm";
import { StepList, TaskToolButtons } from "./TaskTools";
import { capacity, draftOf, fmtDate, fmtDuration, fmtRange, fmtTime, fromMin, taskById, toMin } from "../util";

type Mode = "schedule" | "checklist";

export function useCompletion(state: AppState, actions: AppActions) {
  return async (task: Task, done: boolean) => {
    const prevStatus = task.status;
    const nextStatus = done ? "done" : "open";
    const before = state;
    // Optimistic: cross out immediately.
    actions.setState({
      ...state,
      tasks: state.tasks.map((t) => (t.id === task.id ? { ...t, status: nextStatus, completedAt: done ? new Date().toISOString() : null } : t)),
    });
    try {
      const r = await api("PATCH", `/api/tasks/${task.id}`, { status: nextStatus });
      actions.setState(r.state);
      if (done) {
        actions.toast({
          text: `Done: ${task.title}`,
          action: {
            label: "Undo",
            run: () => actions.mutate("PATCH", `/api/tasks/${task.id}`, { status: prevStatus === "done" ? "open" : prevStatus }),
          },
        });
      }
    } catch (e) {
      actions.setState(before);
      actions.toast({ text: `Couldn't save that change: ${(e as ApiError).message}`, tone: "error" });
    }
  };
}

export function Today({ state, actions, busy }: { state: AppState; actions: AppActions; busy: boolean }) {
  const [mode, setMode] = useState<Mode>("schedule");
  const [replanOpen, setReplanOpen] = useState(false);
  const [wrapOpen, setWrapOpen] = useState(false);
  const canWrap = !!state.plan || doneTodayTasks(state).length > 0;
  const showCheckIn = !state.newDay && !state.plan && !state.proposal?.plan && !!state.lastWrapUp && !state.wrapUpToday;
  const tasks = useMemo(() => taskById(state.tasks), [state.tasks]);
  const complete = useCompletion(state, actions);
  const plan = state.plan;

  return (
    <div className="today">
      <div className="today-head">
        <div>
          <div className="eyebrow">
            {state.weekday} · {fmtDate(state.today, false)} · {fmtTime(state.now)} <span className="muted">({state.timezone})</span>
          </div>
          <h2 className="h2">{plan?.mainOutcome || "Today"}</h2>
          {plan && <div className="muted small">Main outcome · plan v{plan.version}{plan.source === "user-edit" ? " (edited by you)" : ""}</div>}
        </div>
        <div className="row gap wrap head-actions">
          {plan && (
            <button className="btn" onClick={() => { setReplanOpen((o) => !o); setWrapOpen(false); }} disabled={busy}>
              ↻ Update my plan
            </button>
          )}
          {canWrap && !state.wrapUpToday && (
            <button className="btn ghost" onClick={() => { setWrapOpen((o) => !o); setReplanOpen(false); }} disabled={busy}>
              Wrap up my day
            </button>
          )}
        </div>
      </div>

      {state.newDay && <NewDayReview state={state} actions={actions} />}
      {showCheckIn && <MorningCheckIn state={state} actions={actions} />}
      {wrapOpen && <WrapUpPanel state={state} actions={actions} onClose={() => setWrapOpen(false)} busy={busy} />}
      {state.wrapUpToday && !wrapOpen && <WrappedUpNote state={state} onEdit={() => setWrapOpen(true)} />}

      {busy && (
        <div className="card working" role="status">
          <span className="typing inline">
            <span />
            <span />
            <span />
          </span>
          Nikki is working on it…
        </div>
      )}

      {state.proposal && <ProposalCard state={state} proposal={state.proposal} actions={actions} onShowPlan={() => window.scrollTo({ top: 0, behavior: "smooth" })} />}

      {replanOpen && plan && <ReplanForm plan={plan} state={state} actions={actions} onClose={() => setReplanOpen(false)} busy={busy} />}

      {!plan ? (
        showCheckIn ? null : <NoPlan state={state} actions={actions} />
      ) : (
        <>
          <NextUp plan={plan} state={state} tasks={tasks} onToggle={complete} actions={actions} />
          <div className="row between center-y section-gap">
            <div className="segmented" role="tablist" aria-label="Plan view">
              <button className={mode === "schedule" ? "active" : ""} onClick={() => setMode("schedule")} role="tab" aria-selected={mode === "schedule"}>
                Schedule
              </button>
              <button className={mode === "checklist" ? "active" : ""} onClick={() => setMode("checklist")} role="tab" aria-selected={mode === "checklist"}>
                Checklist
              </button>
            </div>
          </div>
          {mode === "schedule" ? (
            <Schedule plan={plan} state={state} tasks={tasks} actions={actions} onToggle={complete} />
          ) : (
            <Checklist plan={plan} tasks={tasks} onToggle={complete} actions={actions} />
          )}
          <Capacity plan={plan} />
          {plan.deferred.length > 0 && (
            <details className="card deferred-card">
              <summary>Not today ({plan.deferred.length})</summary>
              <ul className="plain-list">
                {plan.deferred.map((d) => (
                  <li key={d.taskId}>
                    <strong>{tasks.get(d.taskId)?.title ?? "Removed task"}</strong>
                    <div className="muted small">{d.why}</div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      <Meetings state={state} actions={actions} />
      <Completed state={state} plan={plan} onToggle={complete} actions={actions} />
    </div>
  );
}

function NoPlan({ state, actions }: { state: AppState; actions: AppActions }) {
  if (state.proposal?.plan) return null;
  const open = state.tasks.filter((t) => t.type === "action" && t.status === "open");
  return (
    <div className="card empty-plan">
      <h3 className="h3">No plan for today yet</h3>
      <p className="muted">
        {open.length
          ? `You have ${open.length} open action${open.length > 1 ? "s" : ""}. Tell Nikki how much time you have and she'll suggest priorities.`
          : "Tell Nikki what's on your mind and how much time you have."}
      </p>
      <button className="btn primary" onClick={() => actions.focusComposer(open.length ? "Let's plan today. " : "")}>
        Plan today with Nikki
      </button>
    </div>
  );
}

function NextUp({
  plan,
  state,
  tasks,
  onToggle,
  actions,
}: {
  plan: Plan;
  state: AppState;
  tasks: Map<string, Task>;
  onToggle: (t: Task, d: boolean) => void;
  actions: AppActions;
}) {
  const now = toMin(state.now);
  const next = plan.blocks.find((b) => (b.kind === "focus" || b.kind === "task") && toMin(b.end) > now && b.taskId && tasks.get(b.taskId)?.status !== "done");
  const allDone = plan.blocks.filter((b) => b.taskId).every((b) => tasks.get(b.taskId!)?.status === "done");
  if (allDone) {
    return (
      <div className="card next-up done">
        <div className="eyebrow">Today</div>
        <strong>Everything planned for today is done.</strong>
        <p className="muted small">Add something new with Nikki, or enjoy the space.</p>
      </div>
    );
  }
  if (!next) {
    const leftover = plan.blocks.find((b) => b.taskId && tasks.get(b.taskId)?.status !== "done");
    return (
      <div className="card next-up">
        <div className="eyebrow">Next</div>
        <strong>The planned time has passed{leftover ? ` — “${leftover.title}” is still open` : ""}.</strong>
        <p className="muted small">Use “Update my plan” to fit what's left into the time you have.</p>
      </div>
    );
  }
  const task = tasks.get(next.taskId!)!;
  const isNow = toMin(next.start) <= now;
  return (
    <div className="card next-up">
      <div className="eyebrow">{isNow ? "Now" : `Up next · ${fmtTime(next.start)}`}</div>
      <label className="next-row">
        <input type="checkbox" className="check" checked={task.status === "done"} onChange={(e) => onToggle(task, e.target.checked)} />
        <span>
          <strong className="next-title">{task.title}</strong>
          <span className="muted small block">
            {fmtRange(next.start, next.end)}
            {plan.focusTaskId === task.id ? " · Main focus" : ""}
          </span>
        </span>
      </label>
      <StepList task={task} actions={actions} />
      <TaskToolButtons task={task} actions={actions} timer />
    </div>
  );
}

function Schedule({
  plan,
  state,
  tasks,
  actions,
  onToggle,
}: {
  plan: Plan;
  state: AppState;
  tasks: Map<string, Task>;
  actions: AppActions;
  onToggle: (t: Task, d: boolean) => void;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const now = toMin(state.now);

  const save = async (mutateDraft: (d: ReturnType<typeof draftOf>) => void) => {
    const d = draftOf(plan);
    mutateDraft(d);
    const ok = await actions.mutate("PUT", "/api/plan", { expectedVersion: plan.version, plan: d });
    if (ok) {
      setMenu(null);
      setEditing(null);
    }
    return ok;
  };

  const needMoreTime = (b: PlanBlock, minutes: number) =>
    save((d) => {
      const blk = d.blocks.find((x) => x.id === b.id)!;
      blk.end = fromMin(toMin(blk.end) + minutes);
      d.workBudgetMinutes = Math.max(d.workBudgetMinutes, d.blocks.filter((x) => x.kind === "focus" || x.kind === "task").reduce((s, x) => s + toMin(x.end) - toMin(x.start), 0));
    }).then((ok) => {
      if (!ok) actions.toast({ text: "There isn't room to extend that block. Try “Update my plan” to rebalance the day.", tone: "error" });
    });

  const moveOut = (b: PlanBlock) =>
    save((d) => {
      d.blocks = d.blocks.filter((x) => x.taskId !== b.taskId);
      if (b.taskId && !d.deferred.some((x) => x.taskId === b.taskId)) d.deferred.push({ taskId: b.taskId, why: "You moved this out of today." });
      d.supporting = d.supporting.filter((s) => s.taskId !== b.taskId);
      if (d.focusTaskId === b.taskId) d.focusTaskId = null;
    });

  const markBlocked = async (b: PlanBlock) => {
    const ok = await actions.mutate("PATCH", `/api/tasks/${b.taskId}`, { status: "blocked" });
    if (ok) {
      setMenu(null);
      actions.toast({ text: `“${b.title}” marked blocked. Want to rework the rest of the day?`, action: { label: "Update my plan", run: () => actions.focusComposer("I'm blocked on " + b.title + ". ") } });
    }
  };

  return (
    <ol className="schedule">
      {plan.blocks.map((b) => {
        const task = b.taskId ? tasks.get(b.taskId) : undefined;
        const isWork = b.kind === "focus" || b.kind === "task";
        const current = toMin(b.start) <= now && now < toMin(b.end);
        const past = toMin(b.end) <= now;
        return (
          <li key={b.id} className={`slot kind-${b.kind} ${current ? "current" : ""} ${past ? "past" : ""} ${task?.status === "done" ? "done" : ""}`}>
            <div className="slot-time">
              {fmtTime(b.start)}
              <span className="muted">{fmtDuration(toMin(b.end) - toMin(b.start))}</span>
            </div>
            <div className="slot-body">
              {editing === b.id ? (
                <BlockEditor block={b} onCancel={() => setEditing(null)} onSave={(patch) => save((d) => Object.assign(d.blocks.find((x) => x.id === b.id)!, patch))} />
              ) : (
                <div className="slot-main">
                  {isWork && task ? (
                    <input type="checkbox" className="check" checked={task.status === "done"} onChange={(e) => onToggle(task, e.target.checked)} aria-label={`Mark ${task.title} done`} />
                  ) : (
                    <span className="slot-dot" aria-hidden />
                  )}
                  <div className="slot-text">
                    <span className="slot-title">{task?.title ?? b.title}</span>
                    <span className="slot-meta">
                      {b.kind === "focus" && <span className="tag">Main focus</span>}
                      {b.kind === "meeting" && <span className="tag subtle">Fixed meeting</span>}
                      {b.kind === "buffer" && <span className="muted small">Buffer for overruns</span>}
                      {task?.status === "blocked" && <span className="tag warn">Blocked</span>}
                      {task?.status === "waiting" && <span className="tag subtle">Waiting</span>}
                      {current && <span className="tag now">Now</span>}
                    </span>
                  </div>
                  {b.kind !== "meeting" && (
                    <div className="slot-actions">
                      <button className="icon-btn" aria-label={`Actions for ${b.title}`} aria-expanded={menu === b.id} onClick={() => setMenu(menu === b.id ? null : b.id)}>
                        ⋯
                      </button>
                      {menu === b.id && (
                        <div className="menu" role="menu">
                          {isWork && (
                            <>
                              <button role="menuitem" onClick={() => needMoreTime(b, 15)}>Need more time (+15 min)</button>
                              <button role="menuitem" onClick={() => needMoreTime(b, 30)}>Need more time (+30 min)</button>
                              <button role="menuitem" onClick={() => markBlocked(b)}>I'm blocked</button>
                              <button role="menuitem" onClick={() => moveOut(b)}>Move out of today</button>
                            </>
                          )}
                          {isWork && task && (
                            <>
                              <button role="menuitem" onClick={() => { setMenu(null); actions.openHelper(task.id, "breakdown"); }}>Break it down</button>
                              <button role="menuitem" onClick={() => { setMenu(null); actions.openHelper(task.id, "assist"); }}>Help me start</button>
                            </>
                          )}
                          <button role="menuitem" onClick={() => { setEditing(b.id); setMenu(null); }}>Move / edit time</button>
                          {!isWork && (
                            <button role="menuitem" onClick={() => save((d) => { d.blocks = d.blocks.filter((x) => x.id !== b.id); })}>Remove</button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function BlockEditor({ block, onSave, onCancel }: { block: PlanBlock; onSave: (p: Partial<PlanBlock>) => void; onCancel: () => void }) {
  const [start, setStart] = useState(block.start);
  const [end, setEnd] = useState(block.end);
  const [title, setTitle] = useState(block.title);
  const invalid = !start || !end || toMin(end) <= toMin(start);
  return (
    <form
      className="block-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) onSave({ start, end, title: title.trim() || block.title });
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Block title" />
      <div className="row gap center-y wrap">
        <input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start" />
        <span>–</span>
        <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End" />
        <button className="btn small primary" disabled={invalid}>Save</button>
        <button type="button" className="btn small ghost" onClick={onCancel}>Cancel</button>
      </div>
      {invalid && <span className="error-text small">End must be after start.</span>}
    </form>
  );
}

function Checklist({ plan, tasks, onToggle, actions }: { plan: Plan; tasks: Map<string, Task>; onToggle: (t: Task, d: boolean) => void; actions: AppActions }) {
  const items = [
    ...(plan.focusTaskId ? [{ taskId: plan.focusTaskId, why: plan.focusWhy, focus: true }] : []),
    ...plan.supporting.map((s) => ({ ...s, focus: false })),
  ];
  const seen = new Set(items.map((i) => i.taskId));
  for (const b of plan.blocks) {
    if (b.taskId && !seen.has(b.taskId)) {
      seen.add(b.taskId);
      items.push({ taskId: b.taskId, why: "", focus: false });
    }
  }
  return (
    <ul className="checklist">
      {items.map((i) => {
        const t = tasks.get(i.taskId);
        if (!t) return null;
        return (
          <li key={i.taskId} className={t.status === "done" ? "done" : ""}>
            <label>
              <input type="checkbox" className="check" checked={t.status === "done"} onChange={(e) => onToggle(t, e.target.checked)} />
              <span>
                <span className="slot-title">{t.title}</span>
                {i.focus && <span className="tag">Main focus</span>}
                {t.estimateMinutes ? <span className="muted small"> · {fmtDuration(t.estimateMinutes)}</span> : null}
                {i.why && <span className="why block">{i.why}</span>}
              </span>
            </label>
            <div className="checklist-extra">
              <StepList task={t} actions={actions} compact />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Capacity({ plan }: { plan: Plan }) {
  const c = capacity(plan);
  return (
    <div className="capacity-grid" aria-label="Time summary">
      <div>
        <span className="muted small">Available</span>
        <strong>{fmtDuration(c.available)}</strong>
      </div>
      <div>
        <span className="muted small">Planned work</span>
        <strong>{fmtDuration(c.work)}</strong>
      </div>
      <div>
        <span className="muted small">Breaks</span>
        <strong>{fmtDuration(c.breaks)}</strong>
      </div>
      <div>
        <span className="muted small">Buffer</span>
        <strong>{fmtDuration(c.buffer)}</strong>
      </div>
    </div>
  );
}

function Meetings({ state, actions }: { state: AppState; actions: AppActions }) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", start: "", end: "" });
  const submit = async () => {
    const ok = editId
      ? await actions.mutate("PATCH", `/api/meetings/${editId}`, form)
      : await actions.mutate("POST", "/api/meetings", form);
    if (ok) {
      setAdding(false);
      setEditId(null);
      setForm({ title: "", start: "", end: "" });
    }
  };
  return (
    <div className="card meetings">
      <div className="row between center-y">
        <h3 className="h3">Fixed meetings today</h3>
        {!adding && (
          <button className="btn small ghost" onClick={() => { setAdding(true); setEditId(null); setForm({ title: "", start: "", end: "" }); }}>
            + Add
          </button>
        )}
      </div>
      {state.meetings.length === 0 && !adding && <p className="muted small">None saved. Mention them to Nikki or add one here.</p>}
      <ul className="plain-list">
        {state.meetings.map((m) => (
          <li key={m.id} className="row between center-y">
            <span>
              <strong>{fmtRange(m.start, m.end)}</strong> · {m.title}
            </span>
            <span className="row gap">
              <button className="btn small ghost" onClick={() => { setAdding(true); setEditId(m.id); setForm({ title: m.title, start: m.start, end: m.end }); }}>
                Edit
              </button>
              <button className="btn small ghost" onClick={() => confirm(`Delete “${m.title}”?`) && actions.mutate("DELETE", `/api/meetings/${m.id}`)}>
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      {adding && (
        <form className="meeting-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-label="Meeting title" />
          <input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} aria-label="Start" />
          <input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} aria-label="End" />
          <button className="btn small primary" disabled={!form.title || !form.start || !form.end}>{editId ? "Save" : "Add"}</button>
          <button type="button" className="btn small ghost" onClick={() => { setAdding(false); setEditId(null); }}>Cancel</button>
        </form>
      )}
    </div>
  );
}

function Completed({ state, plan, onToggle, actions }: { state: AppState; plan: Plan | null; onToggle: (t: Task, d: boolean) => void; actions: AppActions }) {
  const inPlan = new Set(plan?.blocks.map((b) => b.taskId).filter(Boolean));
  const done = state.tasks.filter((t) => t.status === "done" && (inPlan.has(t.id) || (t.completedAt && isToday(t.completedAt, state.timezone, state.today))));
  if (!done.length) return null;
  return (
    <div className="card completed">
      <h3 className="h3">Completed today ({done.length})</h3>
      <ul className="plain-list">
        {done.map((t) => (
          <li key={t.id} className="completed-row">
            <span className="struck">{t.title}</span>
            <span className="row gap center-y wrap">
              {t.type === "action" && <ActualTime task={t} actions={actions} />}
              <button className="btn small ghost" onClick={() => onToggle(t, false)}>
                Undo
              </button>
            </span>
          </li>
        ))}
      </ul>
      {state.learning.factor ? (
        <p className="muted small learning-line">
          Nikki is learning your pace: tasks take about {state.learning.factor}× their estimate ({state.learning.samples} measured).
        </p>
      ) : (
        <p className="muted small learning-line">Recording how long tasks really take helps Nikki plan more accurately.</p>
      )}
    </div>
  );
}

function isToday(iso: string, tz: string, today: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)) === today;
  } catch {
    return iso.slice(0, 10) === today;
  }
}

function ReplanForm({ plan, state, actions, onClose, busy }: { plan: Plan; state: AppState; actions: AppActions; onClose: () => void; busy: boolean }) {
  const [until, setUntil] = useState(toMin(plan.window.end) > toMin(state.now) ? plan.window.end : "");
  const [note, setNote] = useState("");
  return (
    <form
      className="card replan"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await actions.replan(until || null, note.trim() || undefined);
        if (ok) onClose();
      }}
    >
      <h3 className="h3">Update my plan</h3>
      <p className="muted small">Nikki will keep completed work and fixed meetings, and only rework the time that's left. You'll see the changes before anything is saved.</p>
      <label className="field">
        <span>Until what time can you keep working today?</span>
        <input type="time" value={until} onChange={(e) => setUntil(e.target.value)} required />
      </label>
      <label className="field">
        <span>Anything new? (optional)</span>
        <input value={note} placeholder="e.g. The client call ran long; I'm low on energy" onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row gap">
        <button className="btn primary" disabled={!until || busy}>Propose an update</button>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

function NewDayReview({ state, actions }: { state: AppState; actions: AppActions }) {
  const nd = state.newDay!;
  const [decisions, setDecisions] = useState<Record<string, "keep" | "done" | "park" | "drop">>(
    Object.fromEntries(nd.unfinishedTaskIds.map((id) => [id, "keep"])),
  );
  const tasks = taskById(state.tasks);
  const submit = async (skip = false) => {
    const ok = await actions.mutate("POST", "/api/review", {
      decisions: skip ? [] : Object.entries(decisions).map(([taskId, action]) => ({ taskId, action })),
    });
    if (ok && !skip) {
      const kept = Object.entries(decisions).filter(([, a]) => a === "keep").map(([id]) => tasks.get(id)?.title).filter(Boolean);
      actions.focusComposer(kept.length ? `Let's plan today. Carrying over: ${kept.join(", ")}. ` : "Let's plan today. ");
    }
  };
  return (
    <div className="card new-day">
      <div className="eyebrow">Welcome back</div>
      <h3 className="h3">
        {nd.unfinishedTaskIds.length} item{nd.unfinishedTaskIds.length > 1 ? "s" : ""} from {fmtDate(nd.lastPlanDate)} weren't finished.
      </h3>
      <p className="muted small">Review them before planning today? Nothing changes until you save.</p>
      <ul className="plain-list">
        {nd.unfinishedTaskIds.map((id) => (
          <li key={id} className="review-row">
            <span>{tasks.get(id)?.title}</span>
            <div className="segmented small" role="radiogroup" aria-label={`What to do with ${tasks.get(id)?.title}`}>
              {(["keep", "done", "park", "drop"] as const).map((a) => (
                <button key={a} type="button" role="radio" aria-checked={decisions[id] === a} className={decisions[id] === a ? "active" : ""} onClick={() => setDecisions({ ...decisions, [id]: a })}>
                  {a === "keep" ? "Keep" : a === "done" ? "Done" : a === "park" ? "Park" : "Drop"}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="row gap wrap">
        <button className="btn primary" onClick={() => submit()}>Save and plan today</button>
        <button className="btn ghost" onClick={() => submit(true)}>Skip review</button>
      </div>
    </div>
  );
}
