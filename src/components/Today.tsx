import { Fragment, useEffect, useMemo, useState } from "react";
import type { AppState, Plan, PlanBlock, Task } from "../../shared/types";
import { api, ApiError } from "../api";
import { AutoTextarea } from "./AutoTextarea";
import type { AppActions } from "../App";
import { ProposalCard } from "./ProposalCard";
import { ActualTime, doneTodayTasks, MorningCheckIn, WrappedUpNote, WrapUpPanel } from "./DayRhythm";
import { StepList, TimerButton } from "./TaskTools";
import { isWeekProposal, Week } from "./Week";
import { DecisionRow, MoveSheet, type MoveChoice } from "./MoveSheet";
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

type RescheduleBody = { to: "later_today" } | { to: "date"; date: string } | { to: "someday" };

/** Direct user actions for unfinished work. They apply immediately and say what happened. */
export function useReschedule(actions: AppActions) {
  return async (task: Task, body: RescheduleBody) => {
    try {
      const r = await api<{ state: AppState; message: string }>("POST", `/api/tasks/${task.id}/reschedule`, body);
      actions.setState(r.state);
      actions.toast({ text: r.message });
      return true;
    } catch (e) {
      const err = e as ApiError;
      actions.toast({ text: err.message, tone: "error" });
      return false;
    }
  };
}

/** Turns a Move… sheet choice into the server call. */
export function useMoveTask(state: AppState, actions: AppActions, onToggle: (t: Task, d: boolean) => void) {
  const reschedule = useReschedule(actions);
  return async (task: Task, choice: MoveChoice, date?: string) => {
    if (choice === "done") return onToggle(task, true);
    if (choice === "drop") {
      const ok = await actions.mutate("DELETE", `/api/tasks/${task.id}`);
      if (ok) actions.toast({ text: `Deleted “${task.title}”.` });
      return;
    }
    if (choice === "later_today") return reschedule(task, { to: "later_today" });
    if (choice === "someday") return reschedule(task, { to: "someday" });
    const d = choice === "today" ? state.today : choice === "tomorrow" ? state.tomorrow.date : date;
    if (d) return reschedule(task, { to: "date", date: d });
  };
}

/** For a task whose planned time passed: Done, or Move… (one sheet, same words everywhere). */
export function MissedActions({ task, state, actions, onToggle }: { task: Task; state: AppState; actions: AppActions; onToggle: (t: Task, d: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const move = useMoveTask(state, actions, onToggle);
  return (
    <div className="missed-actions">
      <button className="btn small" onClick={() => onToggle(task, true)}>Done</button>
      <button className="btn small ghost" onClick={() => setOpen(true)}>Move…</button>
      {open && (
        <MoveSheet
          title={task.title}
          choices={["later_today", "tomorrow", "pick", "someday"]}
          minDate={state.today}
          onClose={() => setOpen(false)}
          onPick={(c, d) => {
            setOpen(false);
            move(task, c, d);
          }}
        />
      )}
    </div>
  );
}

export function Today({ state, actions, busy }: { state: AppState; actions: AppActions; busy: boolean }) {
  const [day, setDay] = useState<"today" | "tomorrow" | "week">("today");
  const proposalDay: "today" | "tomorrow" | "week" = isWeekProposal(state.proposal)
    ? "week"
    : state.proposal?.status === "pending" && state.proposal.date === state.tomorrow.date
      ? "tomorrow"
      : "today";
  // Jump to the day a new proposal is for.
  useEffect(() => {
    if (state.proposal?.status === "pending") setDay(proposalDay);
  }, [state.proposal?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const doneCount = state.plan ? planProgress(state.plan, state.tasks) : null;
  return (
    <div className="today">
      <div className="day-switch-row">
        <div className="segmented day-switch" role="tablist" aria-label="Day">
          <button role="tab" aria-selected={day === "today"} className={day === "today" ? "active" : ""} onClick={() => setDay("today")}>
            Today <span className="muted">· {state.weekday.slice(0, 3)}</span>
            {proposalDay === "today" && state.proposal?.plan && <span className="dot" aria-label="proposal waiting" />}
          </button>
          <button role="tab" aria-selected={day === "tomorrow"} className={day === "tomorrow" ? "active" : ""} onClick={() => setDay("tomorrow")}>
            Tomorrow <span className="muted">· {state.tomorrow.weekday.slice(0, 3)}</span>
            {proposalDay === "tomorrow" && <span className="dot" aria-label="proposal waiting" />}
          </button>
          <button role="tab" aria-selected={day === "week"} className={day === "week" ? "active" : ""} onClick={() => setDay("week")}>
            Week
            {proposalDay === "week" && <span className="dot" aria-label="proposal waiting" />}
          </button>
        </div>
        {day === "today" && doneCount && doneCount.total > 0 && <ProgressRing done={doneCount.done} total={doneCount.total} />}
      </div>
      {day === "today" ? (
        <TodayBody state={state} actions={actions} busy={busy} />
      ) : day === "tomorrow" ? (
        <TomorrowBody state={state} actions={actions} busy={busy} />
      ) : (
        <Week state={state} actions={actions} busy={busy} onOpenDay={setDay} />
      )}
    </div>
  );
}

/** Done vs planned work tasks in a plan. */
export function planProgress(plan: Plan, tasks: Task[]) {
  const ids = new Set(plan.blocks.filter((b) => (b.kind === "focus" || b.kind === "task") && b.taskId).map((b) => b.taskId!));
  const byId = taskById(tasks);
  const list = [...ids].map((id) => byId.get(id)).filter(Boolean) as Task[];
  return { done: list.filter((t) => t.status === "done").length, total: list.length };
}

export function ProgressRing({ done, total, size = 44 }: { done: number; total: number; size?: number }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const pct = total ? done / total : 0;
  return (
    <div className="progress-ring" title={`${done} of ${total} planned tasks done`} aria-label={`${done} of ${total} planned tasks done`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-bg" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="ring-fg"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="ring-label">
        {done}/{total}
      </span>
    </div>
  );
}

function TodayBody({ state, actions, busy }: { state: AppState; actions: AppActions; busy: boolean }) {
  const [mode, setMode] = useState<Mode>("schedule");
  const [replanOpen, setReplanOpen] = useState(false);
  const [wrapOpen, setWrapOpen] = useState(false);
  const canWrap = !!state.plan || doneTodayTasks(state).length > 0;
  const showCheckIn = !state.newDay && !state.plan && !state.proposal?.plan && !!state.lastWrapUp && !state.wrapUpToday;
  const tasks = useMemo(() => taskById(state.tasks), [state.tasks]);
  const complete = useCompletion(state, actions);
  const plan = state.plan;

  return (
    <>
      <div className="today-head">
        <div>
          <h2 className="h2">{fmtDate(state.today)}</h2>
          <div className="muted small">{fmtTime(state.now)}</div>
        </div>
        <div className="row gap wrap head-actions">
          {plan && (
            <button className="btn" onClick={() => { setReplanOpen((o) => !o); setWrapOpen(false); }} disabled={busy}>
              Replan
            </button>
          )}
          {canWrap && !state.wrapUpToday && (
            <button className="btn ghost" onClick={() => { setWrapOpen((o) => !o); setReplanOpen(false); }} disabled={busy}>
              Wrap up
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

      {state.proposal && state.proposal.date !== state.tomorrow.date && !isWeekProposal(state.proposal) && (
        <ProposalCard state={state} proposal={state.proposal} actions={actions} onShowPlan={() => window.scrollTo({ top: 0, behavior: "smooth" })} />
      )}

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
            <Schedule plan={plan} state={state} tasks={tasks} actions={actions} onToggle={complete} isToday />
          ) : (
            <Checklist plan={plan} tasks={tasks} onToggle={complete} actions={actions} />
          )}
          <Capacity plan={plan} />
          {plan.deferred.length > 0 && (
            <details className="card deferred-card">
              <summary className="section-summary">Deferred ({plan.deferred.length})</summary>
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

      <Meetings state={state} actions={actions} date={state.today} meetings={state.meetings} label="today" />
      <Completed state={state} plan={plan} onToggle={complete} actions={actions} />
    </>
  );
}

function TomorrowBody({ state, actions, busy }: { state: AppState; actions: AppActions; busy: boolean }) {
  const t = state.tomorrow;
  const tasks = useMemo(() => taskById(state.tasks), [state.tasks]);
  const complete = useCompletion(state, actions);
  const proposal = state.proposal?.date === t.date ? state.proposal : null;
  return (
    <>
      <div className="today-head">
        <div>
          <h2 className="h2">{fmtDate(t.date)}</h2>
        </div>
        {t.plan && (
          <button className="btn" onClick={() => actions.focusComposer("Let's adjust tomorrow's plan: ")} disabled={busy}>
            Replan
          </button>
        )}
      </div>
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
      {proposal && <ProposalCard state={state} proposal={proposal} actions={actions} onShowPlan={() => window.scrollTo({ top: 0, behavior: "smooth" })} />}
      {t.plan ? (
        <>
          <Schedule plan={t.plan} state={state} tasks={tasks} actions={actions} onToggle={complete} isToday={false} />
          <Capacity plan={t.plan} />
        </>
      ) : (
        !proposal && (
          <div className="card empty-plan">
            <h3 className="h3">No plan yet</h3>
            <button className="btn primary" onClick={() => actions.focusComposer("Let's plan tomorrow. ")}>
              Plan tomorrow
            </button>
          </div>
        )
      )}
      <Meetings state={state} actions={actions} date={t.date} meetings={t.meetings} label="tomorrow" />
    </>
  );
}

function NoPlan({ state, actions }: { state: AppState; actions: AppActions }) {
  if (state.proposal?.plan) return null;
  const open = state.tasks.filter((t) => t.type === "action" && t.status === "open");
  return (
    <div className="card empty-plan">
      <h3 className="h3">No plan yet</h3>
      <p className="muted">
        {open.length ? `${open.length} open action${open.length > 1 ? "s" : ""}. Tell Nikki how much time you have.` : "Tell Nikki what's on your plate and how much time you have."}
      </p>
      <button className="btn primary" onClick={() => actions.focusComposer(open.length ? "Let's plan today. " : "")}>
        Plan today
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
  const allDone = plan.blocks.filter((b) => b.taskId && tasks.has(b.taskId)).every((b) => tasks.get(b.taskId!)?.status === "done");
  const missed = new Set(
    plan.blocks.filter((b) => (b.kind === "focus" || b.kind === "task") && toMin(b.end) <= now && b.taskId && tasks.has(b.taskId) && tasks.get(b.taskId)?.status !== "done").map((b) => b.taskId),
  ).size;
  const missedNote =
    missed > 0 ? (
      <p className="missed-note small">
        {missed === 1 ? "1 task not finished" : `${missed} tasks not finished`} — see the schedule below.
      </p>
    ) : null;
  if (allDone) {
    return (
      <div className="card next-up done">
        <div className="eyebrow">Done</div>
        <strong>Everything planned for today is done.</strong>
      </div>
    );
  }
  if (!next) {
    return (
      <div className="card next-up">
        <div className="eyebrow">Next up</div>
        <strong>Nothing else scheduled today.</strong>
        {missedNote}
      </div>
    );
  }
  const task = tasks.get(next.taskId!)!;
  const isNow = toMin(next.start) <= now;
  return (
    <div className="card next-up">
      <div className="eyebrow">{isNow ? "Now" : "Next up"}</div>
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
      <div className="task-tools">
        <TimerButton task={task} actions={actions} />
      </div>
      {missedNote}
    </div>
  );
}

function Schedule({
  plan,
  state,
  tasks,
  actions,
  onToggle,
  isToday,
}: {
  plan: Plan;
  state: AppState;
  tasks: Map<string, Task>;
  actions: AppActions;
  onToggle: (t: Task, d: boolean) => void;
  isToday: boolean;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const now = isToday ? toMin(state.now) : -1;
  // Where the "now" line goes: before the first block that starts after now.
  const nowIndex =
    isToday && now >= toMin(plan.window.start) && now < toMin(plan.window.end) && !plan.blocks.some((b) => toMin(b.start) <= now && now < toMin(b.end))
      ? plan.blocks.findIndex((b) => toMin(b.start) > now)
      : -1;

  const save = async (mutateDraft: (d: ReturnType<typeof draftOf>) => void) => {
    const d = draftOf(plan);
    mutateDraft(d);
    const ok = await actions.mutate("PUT", "/api/plan", { expectedVersion: plan.version, plan: d, date: plan.date });
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
      if (!ok) actions.toast({ text: "There isn't room to extend that block. Tap Replan to rebalance the day.", tone: "error" });
    });

  const [moving, setMoving] = useState<Task | null>(null);
  const move = useMoveTask(state, actions, onToggle);

  return (
    <>
    <ol className="schedule">
      {plan.blocks.map((b, idx) => {
        const task = b.taskId ? tasks.get(b.taskId) : undefined;
        const isWork = b.kind === "focus" || b.kind === "task";
        const current = toMin(b.start) <= now && now < toMin(b.end);
        const past = toMin(b.end) <= now;
        return (
          <Fragment key={b.id}>
          {idx === nowIndex && (
            <li className="now-line" aria-label={`Now, ${fmtTime(state.now)}`}>
              <span>{fmtTime(state.now)}</span>
            </li>
          )}
          <li className={`slot kind-${b.kind} ${current ? "current" : ""} ${past ? "past" : ""} ${past && isWork && task && task.status !== "done" ? "missed" : ""} ${task?.status === "done" ? "done" : ""}`}>
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
                      {b.kind === "meeting" && state.meetings.concat(state.tomorrow.meetings).find((m) => m.id === b.meetingId)?.source === "calendar" && (
                        <span className="tag subtle">Calendar</span>
                      )}
                      {task?.status === "blocked" && <span className="tag warn">Blocked</span>}
                      {task?.status === "waiting" && <span className="tag subtle">Waiting</span>}
                      {current && <span className="tag now">Now</span>}
                      {past && isWork && task && task.status !== "done" && <span className="tag warn">Not finished</span>}
                    </span>
                    {past && isWork && task && task.status !== "done" && (
                      <MissedActions task={task} state={state} actions={actions} onToggle={onToggle} />
                    )}
                  </div>
                  {b.kind !== "meeting" && (
                    <div className="slot-actions">
                      <button className="icon-btn" aria-label={`Actions for ${b.title}`} aria-expanded={menu === b.id} onClick={() => setMenu(menu === b.id ? null : b.id)}>
                        ⋯
                      </button>
                      {menu === b.id && (
                        <>
                          <div className="menu-backdrop" onClick={() => setMenu(null)} aria-hidden />
                          <div className="menu" role="menu">
                            {isWork && <button role="menuitem" onClick={() => needMoreTime(b, 15)}>+15 min</button>}
                            {isWork && task && (
                              <button role="menuitem" onClick={() => { setMenu(null); setMoving(task); }}>Move…</button>
                            )}
                            {isWork && task && (
                              <>
                                <button role="menuitem" onClick={() => { setMenu(null); actions.openHelper(task.id, "breakdown"); }}>Break it down</button>
                                <button role="menuitem" onClick={() => { setMenu(null); actions.openHelper(task.id, "assist"); }}>Help me start</button>
                              </>
                            )}
                            <button role="menuitem" onClick={() => { setEditing(b.id); setMenu(null); }}>Edit time</button>
                            {!isWork && (
                              <button role="menuitem" onClick={() => save((d) => { d.blocks = d.blocks.filter((x) => x.id !== b.id); })}>Remove</button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </li>
          </Fragment>
        );
      })}
    </ol>
      {moving && (
        <MoveSheet
          title={moving.title}
          choices={isToday ? ["later_today", "tomorrow", "pick", "someday"] : ["today", "pick", "someday"]}
          minDate={state.today}
          onClose={() => setMoving(null)}
          onPick={(c, d) => {
            const t = moving;
            setMoving(null);
            move(t, c, d);
          }}
        />
      )}
    </>
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
      <AutoTextarea value={title} onChange={setTitle} submitOnEnter aria-label="Block title" />
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
  if (!c.available) return null;
  const parts = [
    { key: "work", label: "Planned work", value: c.work },
    { key: "break", label: "Breaks", value: c.breaks },
    { key: "buffer", label: "Buffer", value: c.buffer },
    { key: "open", label: "Free", value: c.open },
  ].filter((p) => p.value > 0);
  return (
    <div className="card capacity" aria-label="How your time adds up">
      <div className="row between center-y wrap gap">
        <span>
          <strong>{fmtDuration(c.available)}</strong> <span className="muted small">free between {fmtRange(plan.window.start, plan.window.end)}</span>
        </span>
        {c.meetings > 0 && <span className="muted small">after {fmtDuration(c.meetings)} of meetings</span>}
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

function Meetings({
  state,
  actions,
  date,
  meetings,
  label,
}: {
  state: AppState;
  actions: AppActions;
  date: string;
  meetings: AppState["meetings"];
  label: string;
}) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", start: "", end: "" });
  const submit = async () => {
    const ok = editId
      ? await actions.mutate("PATCH", `/api/meetings/${editId}`, { ...form, date })
      : await actions.mutate("POST", "/api/meetings", { ...form, date });
    if (ok) {
      setAdding(false);
      setEditId(null);
      setForm({ title: "", start: "", end: "" });
    }
  };
  return (
    <div className="card meetings">
      <div className="row between center-y">
        <h3 className="h3">Meetings</h3>
        {!adding && (
          <button className="btn small ghost" onClick={() => { setAdding(true); setEditId(null); setForm({ title: "", start: "", end: "" }); }}>
            + Add
          </button>
        )}
      </div>
      {meetings.length === 0 && !adding && <p className="muted small">None saved. Mention them to Nikki or add one here.</p>}
      <ul className="plain-list">
        {meetings.map((m) => (
          <li key={m.id} className="row between center-y">
            <span>
              <strong>{fmtRange(m.start, m.end)}</strong> · {m.title}
              {m.source === "calendar" && <span className="tag subtle cal-tag">Calendar</span>}
            </span>
            {m.source !== "calendar" && <span className="row gap">
              <button className="btn small ghost" onClick={() => { setAdding(true); setEditId(m.id); setForm({ title: m.title, start: m.start, end: m.end }); }}>
                Edit
              </button>
              <button className="btn small ghost" onClick={() => confirm(`Delete “${m.title}”?`) && actions.mutate("DELETE", `/api/meetings/${m.id}`)}>
                Delete
              </button>
            </span>}
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
      <h3 className="h3">Done today ({done.length})</h3>
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
      <h3 className="h3">Replan</h3>
      <p className="muted small">Completed work and meetings stay fixed.</p>
      <label className="field">
        <span>Work until</span>
        <input type="time" value={until} onChange={(e) => setUntil(e.target.value)} required />
      </label>
      <label className="field">
        <span>What changed? (optional)</span>
        <AutoTextarea value={note} placeholder="e.g. The client call ran long; I'm low on energy" onChange={setNote} />
      </label>
      <div className="row gap">
        <button className="btn primary" disabled={!until || busy}>Replan</button>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

type ReviewAction = "today" | "tomorrow" | "done" | "someday" | "drop";
const REVIEW_TO_MOVE: Record<ReviewAction, MoveChoice> = { today: "today", tomorrow: "tomorrow", done: "done", someday: "someday", drop: "drop" };
const REVIEW_SHORT: Record<ReviewAction, string> = { today: "Today", tomorrow: "Tomorrow", done: "Done", someday: "Someday", drop: "Delete" };

function NewDayReview({ state, actions }: { state: AppState; actions: AppActions }) {
  const nd = state.newDay!;
  const [decisions, setDecisions] = useState<Record<string, ReviewAction>>(Object.fromEntries(nd.unfinishedTaskIds.map((id) => [id, "today"])));
  const tasks = taskById(state.tasks);
  const submit = async (skip = false) => {
    const ok = await actions.mutate("POST", "/api/review", {
      decisions: skip ? [] : Object.entries(decisions).map(([taskId, action]) => ({ taskId, action })),
    });
    if (ok && !skip) {
      const kept = Object.entries(decisions).filter(([, a]) => a === "today").map(([id]) => tasks.get(id)?.title).filter(Boolean);
      if (!state.plan) actions.focusComposer(kept.length ? `Let's plan today. Carrying over: ${kept.join(", ")}. ` : "Let's plan today. ");
      else actions.toast({ text: kept.length ? `${kept.length} carried into today. Ask Nikki to fit ${kept.length === 1 ? "it" : "them"} into the plan.` : "Saved." });
    }
  };
  const n = nd.unfinishedTaskIds.length;
  return (
    <div className="card new-day">
      <h3 className="h3">Carried over ({n})</h3>
      <p className="muted small">Not finished earlier. These move to today unless you change them.</p>
      <ul className="plain-list decisions">
        {nd.unfinishedTaskIds.map((id) => {
          const t = tasks.get(id);
          if (!t) return null;
          return (
            <DecisionRow
              key={id}
              title={t.title}
              note={t.rolloverCount ? `moved ${t.rolloverCount}× before` : undefined}
              value={decisions[id]}
              labels={REVIEW_SHORT}
              choices={["today", "tomorrow", "someday", "done", "drop"]}
              toMove={REVIEW_TO_MOVE}
              minDate={state.today}
              onChange={(a) => setDecisions({ ...decisions, [id]: a })}
            />
          );
        })}
      </ul>
      <div className="row gap wrap">
        <button className="btn primary" onClick={() => submit()}>Confirm</button>
        <button className="btn ghost" onClick={() => submit(true)}>Skip</button>
      </div>
    </div>
  );
}
