import { Fragment, useEffect, useMemo, useState } from "react";
import type { AppState, Plan, PlanBlock, Task } from "../../shared/types";
import { api, ApiError } from "../api";
import { AutoTextarea } from "./AutoTextarea";
import type { AppActions } from "../App";
import { ProposalCard } from "./ProposalCard";
import { ActualTime, doneTodayTasks, MorningCheckIn, WrapUpPanel } from "./DayRhythm";
import { DayBar } from "./DayBar";
import { EarlierToday } from "./History";
import { ReminderSheet, ReminderStrip } from "./Reminders";
import { TodayHero } from "./Hero";
import { AddTask, CarryLine, ContextBanner, DayTasks, FocusCard, useTimerControls } from "./TaskList";
import { isWeekProposal, Week } from "./Week";
import { ActionSheet, DecisionRow, MoveSheet, type MoveChoice } from "./MoveSheet";
import { capacity, draftOf, fmtDate, fmtDuration, fmtRange, fmtTime, fromMin, taskById, toMin } from "../util";

type Mode = "list" | "timeline";

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
  // Progress is the whole day's list (assigned and scheduled tasks), not only the scheduled ones.
  const d0 = state.days[0];
  const doneCount = d0 ? { done: d0.doneCount, total: d0.doneCount + d0.openIds.length } : null;
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
  const [mode, setMode] = useState<Mode>("list");
  const timers = useTimerControls(state, actions);
  const [replanOpen, setReplanOpen] = useState(false);
  const [wrapOpen, setWrapOpen] = useState(false);
  const canWrap = !!state.plan || doneTodayTasks(state).length > 0;
  const showCheckIn = !state.newDay && !state.plan && !state.proposal?.plan && !!state.lastWrapUp && !state.wrapUpToday;
  const tasks = useMemo(() => taskById(state.tasks), [state.tasks]);
  const complete = useCompletion(state, actions);
  const plan = state.plan;
  const [dayMenu, setDayMenu] = useState(false);
  const [addingReminder, setAddingReminder] = useState(false);
  const openReplan = () => {
    setReplanOpen(true);
    setWrapOpen(false);
  };
  const openWrap = () => {
    setWrapOpen(true);
    setReplanOpen(false);
  };
  const proposalToday = !!state.proposal?.plan && state.proposal.date === state.today;
  const quiet = !showCheckIn && !proposalToday && !wrapOpen && !replanOpen;
  const dayOver = !!plan && !state.wrapUpToday && toMin(state.now) >= toMin(plan.window.end);

  return (
    <>
      <TodayHero
        state={state}
        actions={actions}
        timers={timers}
        menu={
          <>
            <button className="icon-btn head-more" aria-label="Day options" onClick={() => setDayMenu(true)} disabled={busy}>
              ⋯
            </button>
            {addingReminder && <ReminderSheet state={state} actions={actions} onClose={() => setAddingReminder(false)} />}
            {dayMenu && (
              <ActionSheet
                title="Today"
                onClose={() => setDayMenu(false)}
                items={[
                  { label: "Add a reminder…", run: () => setAddingReminder(true) },
                  {
                    label: "Weekly review",
                    run: () => {
                      actions.focusComposer();
                      void actions.send("Weekly review.", "weekly_review");
                    },
                  },
                  ...(plan ? [{ label: "Replan the rest of today", run: openReplan }] : []),
                  ...(canWrap ? [{ label: state.wrapUpToday ? "Edit wrap-up" : "Wrap up the day", run: openWrap }] : []),
                ]}
              />
            )}
          </>
        }
      />

      {showCheckIn && <MorningCheckIn state={state} actions={actions} />}
      {wrapOpen && <WrapUpPanel state={state} actions={actions} onClose={() => setWrapOpen(false)} busy={busy} />}

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

      <ReminderStrip state={state} actions={actions} date={state.today} />
      <FocusCard state={state} actions={actions} timers={timers} />
      {quiet && <ContextBanner state={state} actions={actions} timers={timers} onWrap={dayOver ? openWrap : undefined} />}

      {plan && (
        <div className="row between center-y section-gap">
          <div className="segmented" role="tablist" aria-label="Today view">
            <button className={mode === "list" ? "active" : ""} onClick={() => setMode("list")} role="tab" aria-selected={mode === "list"}>
              List
            </button>
            <button className={mode === "timeline" ? "active" : ""} onClick={() => setMode("timeline")} role="tab" aria-selected={mode === "timeline"}>
              Timeline
            </button>
          </div>
        </div>
      )}
      {mode === "list" || !plan ? (
        <>
          <DayTasks state={state} actions={actions} date={state.today} plan={plan} onToggle={complete} timers={timers} empty="Nothing for today yet. Add a task below or tell Nikki what’s on your plate." />
          <CarryLine state={state} actions={actions} onToggle={complete}>
            {state.newDay && <NewDayReview state={state} actions={actions} />}
          </CarryLine>
          {!plan && state.days[0]?.openIds.length > 0 && !state.proposal?.plan && (
            <div className="row gap wrap plan-offer">
              <button className="btn" onClick={() => actions.focusComposer("Plan my day. ")}>
                Plan my day
              </button>
              <span className="muted small">Optional. You can start any task without a plan.</span>
            </div>
          )}
        </>
      ) : (
        <>
          <Schedule plan={plan} state={state} tasks={tasks} actions={actions} onToggle={complete} isToday />
          <DayBar plan={plan} now={state.now} />
          {plan.deferred.length > 0 && (
            <details className="card deferred-card">
              <summary className="section-summary">Not scheduled ({plan.deferred.length})</summary>
              <ul className="plain-list">
                {plan.deferred.map((d) => (
                  <li key={d.taskId}>
                    <strong>{tasks.get(d.taskId)?.title ?? "Removed task"}</strong>
                    <div className="muted small">{d.why} Still on today’s list.</div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {timers.sheets}

      <EarlierToday state={state} actions={actions} />
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
  const timers = useTimerControls(state, actions);
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
      <ReminderStrip state={state} actions={actions} date={t.date} />
      <DayTasks state={state} actions={actions} date={t.date} plan={t.plan} onToggle={complete} timers={timers} empty="Nothing assigned to tomorrow yet. Add a task below." />
      {t.plan && (
        <details className="card">
          <summary className="section-summary">Timeline</summary>
          <Schedule plan={t.plan} state={state} tasks={tasks} actions={actions} onToggle={complete} isToday={false} />
          <DayBar plan={t.plan} />
        </details>
      )}
      {!t.plan && !proposal && state.days[1]?.openIds.length > 0 && (
        <div className="row gap wrap plan-offer">
          <button className="btn" onClick={() => actions.focusComposer("Let's plan tomorrow. ")}>
            Arrange tomorrow
          </button>
          <span className="muted small">Optional. Tasks stay on tomorrow either way.</span>
        </div>
      )}
      {timers.sheets}
      <Meetings state={state} actions={actions} date={t.date} meetings={t.meetings} label="tomorrow" />
    </>
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
        // A task that continues in a later block today isn't "not finished" yet.
        const continues = !!b.taskId && plan.blocks.some((x) => x.taskId === b.taskId && toMin(x.end) > now);
        const missed = past && isWork && !!task && task.status !== "done" && !continues;
        return (
          <Fragment key={b.id}>
          {idx === nowIndex && (
            <li className="now-line" aria-label={`Now, ${fmtTime(state.now)}`}>
              <span>{fmtTime(state.now)}</span>
            </li>
          )}
          <li className={`slot kind-${b.kind} ${current ? "current" : ""} ${past ? "past" : ""} ${missed ? "missed" : ""} ${task?.status === "done" ? "done" : ""}`}>
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
                      {missed && <span className="tag warn">Not finished</span>}
                    </span>
                    {missed && task && (
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
        <h3 className="h3">Commitments</h3>
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

type ReviewAction = "today" | "tomorrow" | "date" | "done" | "someday" | "drop";
const REVIEW_TO_MOVE: Record<ReviewAction, MoveChoice> = { today: "today", tomorrow: "tomorrow", date: "pick", done: "done", someday: "someday", drop: "drop" };
const REVIEW_SHORT: Record<ReviewAction, string> = { today: "Today", tomorrow: "Tomorrow", date: "Pick a day", done: "Done", someday: "Someday", drop: "Delete" };

function NewDayReview({ state, actions }: { state: AppState; actions: AppActions }) {
  const nd = state.newDay!;
  const [decisions, setDecisions] = useState<Record<string, ReviewAction>>(Object.fromEntries(nd.unfinishedTaskIds.map((id) => [id, "today"])));
  const [dates, setDates] = useState<Record<string, string>>({});
  const tasks = taskById(state.tasks);
  const submit = async (skip = false) => {
    const ok = await actions.mutate("POST", "/api/review", {
      decisions: skip ? [] : Object.entries(decisions).map(([taskId, action]) => ({ taskId, action, ...(action === "date" ? { date: dates[taskId] } : {}) })),
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
              choices={["today", "tomorrow", "date", "someday", "done", "drop"]}
              toMove={REVIEW_TO_MOVE}
              minDate={state.today}
              date={dates[id]}
              onChange={(a, d) => {
                setDecisions({ ...decisions, [id]: a });
                if (d) setDates({ ...dates, [id]: d });
              }}
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
