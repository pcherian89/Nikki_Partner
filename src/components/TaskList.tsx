import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AppState, OverrunPreview, Plan, Task, TaskPriority, TaskMeta, WorkSession } from "../../shared/types";
import { api, ApiError, serverNowMs } from "../api";
import type { AppActions } from "../App";
import { fmtDate, fmtDuration, fmtRange, fmtTime, toMin } from "../util";
import { ActionSheet, MoveSheet, type SheetAction } from "./MoveSheet";
import { StepList, useTimerMinutes } from "./TaskTools";
import { useMoveTask } from "./Today";
import { ReminderSheet } from "./Reminders";

const WORK = new Set(["focus", "task"]);

// ---------- small helpers ----------

async function call(actions: AppActions, method: string, url: string, body?: unknown) {
  try {
    const r = await api<any>(method, url, body);
    if (r.state) actions.setState(r.state);
    return { ok: true as const, res: r };
  } catch (e) {
    return { ok: false as const, err: e as ApiError };
  }
}

/** Phone-friendly bottom sheet for a short form. */
export function FormSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet form-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" aria-hidden />
        <div className="sheet-title">{title}</div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

function blocksOf(plan: Plan | null | undefined, taskId: string) {
  return (plan?.blocks ?? []).filter((b) => b.taskId === taskId && WORK.has(b.kind));
}

/** Overdue / at risk first, then "if time allows" last, then priority, then scheduled time. */
export function sortTasks(tasks: Task[], meta: Record<string, TaskMeta>, plan: Plan | null) {
  const risk = (t: Task) => (meta[t.id]?.deadlineStatus === "overdue" ? 0 : meta[t.id]?.deadlineStatus === "at_risk" ? 1 : 2);
  const at = (t: Task) => {
    const b = blocksOf(plan, t.id)[0];
    return b ? toMin(b.start) : 9999;
  };
  return [...tasks].sort(
    (a, b) =>
      risk(a) - risk(b) ||
      Number(a.optional) - Number(b.optional) ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      at(a) - at(b) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

// ---------- timer controls shared by every row and card ----------

export function useTimerControls(state: AppState, actions: AppActions) {
  const [switching, setSwitching] = useState<{ task: Task; running: { runningTaskId: string; title: string; minutes: number } } | null>(null);
  const [check, setCheck] = useState<{ session: WorkSession; title: string } | null>(null);

  const offerCheck = (session: WorkSession | null | undefined, title: string) => {
    if (session && session.verified === false) setCheck({ session, title });
  };

  const start = async (task: Task, mode?: "pause" | "finish") => {
    const r = await call(actions, "POST", `/api/tasks/${task.id}/timer`, { action: "start", ...(mode ? { switch: mode } : {}) });
    if (!r.ok) {
      if (r.err.code === "timer_running" && r.err.data) setSwitching({ task, running: r.err.data as any });
      else actions.toast({ text: r.err.message, tone: "error" });
      return;
    }
    const p = r.res.paused;
    if (p?.session) offerCheck(p.session, p.title);
  };
  const pause = async (task: Task) => {
    const r = await call(actions, "POST", `/api/tasks/${task.id}/timer`, { action: "stop" });
    if (!r.ok) return actions.toast({ text: r.err.message, tone: "error" });
    offerCheck(r.res.session, task.title);
  };
  const finish = async (task: Task) => {
    const r = await call(actions, "POST", `/api/tasks/${task.id}/finish`, {});
    if (!r.ok) return actions.toast({ text: r.err.message, tone: "error" });
    offerCheck(r.res.session, task.title);
    actions.toast({
      text: `Done: ${task.title}`,
      action: { label: "Undo", run: () => actions.mutate("PATCH", `/api/tasks/${task.id}`, { status: "open" }) },
    });
  };

  const sheets = (
    <>
      {switching && (
        <ActionSheet
          title={`“${switching.running.title}” is running`}
          onClose={() => setSwitching(null)}
          items={[
            { label: `Pause it and start “${switching.task.title}”`, run: () => start(switching.task, "pause") },
            { label: `Finish it and start “${switching.task.title}”`, run: () => start(switching.task, "finish") },
          ]}
        />
      )}
      {check && <CheckSheet session={check.session} title={check.title} actions={actions} onClose={() => setCheck(null)} />}
    </>
  );
  return { start, pause, finish, sheets };
}

/** Uncertain timer time: keep it, set the real minutes, or discard it. Nothing is counted until the user answers. */
export function CheckSheet({ session, title, actions, onClose }: { session: WorkSession; title: string; actions: AppActions; onClose: () => void }) {
  const [minutes, setMinutes] = useState(String(session.minutes));
  const apply = async (body: Record<string, unknown>) => {
    const ok = await actions.mutate("PATCH", `/api/sessions/${session.id}`, body);
    if (ok) onClose();
  };
  const n = Math.round(Number(minutes));
  return (
    <FormSheet title="Check this time" onClose={onClose}>
      <p className="muted small sheet-note">
        “{title}” ran for {fmtDuration(session.minutes)}. That looks long, so it isn’t counted until you confirm it.
      </p>
      <div className="sheet-form">
        <button className="btn primary" onClick={() => apply({ keep: true })}>
          Keep {fmtDuration(session.minutes)}
        </button>
        <label className="field">
          <span>Or set the real time (minutes)</span>
          <input type="number" min={1} max={1440} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </label>
        <button className="btn" disabled={!(n >= 1 && n <= 1440)} onClick={() => apply({ minutes: n })}>
          Set {n >= 1 ? fmtDuration(n) : "time"}
        </button>
        <button className="btn ghost danger-text" onClick={() => apply({ discard: true })}>
          Discard this time
        </button>
        <button className="btn ghost" onClick={onClose}>
          Decide later
        </button>
      </div>
    </FormSheet>
  );
}

// ---------- add a task ----------

export function AddTask({ actions, plannedDate, placeholder, projectId }: { actions: AppActions; plannedDate: string | null; placeholder?: string; projectId?: string }) {
  const [title, setTitle] = useState("");
  const submit = async () => {
    const t = title.trim();
    if (!t) return;
    const ok = await actions.mutate("POST", "/api/tasks", { title: t, plannedDate, ...(projectId ? { projectId } : {}) });
    if (ok) setTitle("");
  };
  return (
    <form
      className="add-task"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={placeholder ?? "+ Add task"} aria-label="Add a task" maxLength={300} />
      {title.trim() && <button className="btn small primary">Add</button>}
    </form>
  );
}

// ---------- a task row ----------

export function dueLabel(t: Task, today: string) {
  if (!t.deadline) return null;
  const time = t.deadlineTime ? fmtTime(t.deadlineTime) : null;
  if (t.deadline === today) return time ? `Due ${time}` : "Due today";
  const d = fmtDate(t.deadline, false);
  return time ? `Due ${d}, ${time}` : `Due ${d}`;
}

export function TaskMetaChips({ task, state, plan }: { task: Task; state: AppState; plan: Plan | null }) {
  const m = state.taskMeta[task.id];
  const due = dueLabel(task, state.today);
  const blocks = blocksOf(plan, task.id);
  const checks = state.checks.filter((s) => s.taskId === task.id);
  return (
    <span className="task-meta">
      {task.priority === "high" && <span className="tag high">High</span>}
      {task.priority === "low" && <span className="muted small">Low priority</span>}
      {task.projectId && state.projects.find((p) => p.id === task.projectId) && <span className="tag subtle project-chip">{state.projects.find((p) => p.id === task.projectId)!.title}</span>}
      {task.optional && <span className="tag optional">If time allows</span>}
      {blocks[0] && (
        <span className="muted small">
          {fmtRange(blocks[0].start, blocks[0].end)}
          {blocks.length > 1 ? ` +${blocks.length - 1}` : ""}
          {blocks[0].provisional ? " · provisional" : ""}
        </span>
      )}
      {due && (
        <span className={`tag ${m?.deadlineStatus === "overdue" || m?.deadlineStatus === "at_risk" ? "warn" : "subtle"}`}>
          {m?.deadlineStatus === "overdue" ? `Overdue · ${due.replace("Due ", "was ")}` : due}
          {m?.deadlineStatus === "at_risk" ? ` · at risk${m.shortByMinutes ? `, ${fmtDuration(m.shortByMinutes)} short` : ""}` : ""}
          {m?.deadlineStatus === "no_estimate" ? " · no estimate" : ""}
        </span>
      )}
      {m && m.remainingMinutes != null && (m.workedMinutes > 0 || task.estimateMinutes) && (
        <span className="muted small">{m.remainingMinutes > 0 ? `${fmtDuration(m.remainingMinutes)} left` : "Estimate used"}</span>
      )}
      {m && m.sessionCount > 1 && (
        <span className="muted small">
          {m.sessionCount} sessions · {fmtDuration(m.workedMinutes)}
        </span>
      )}
      {checks.length > 0 && <span className="tag warn">+{fmtDuration(checks.reduce((a, s) => a + s.minutes, 0))} to check</span>}
    </span>
  );
}

export function TaskRow({
  task,
  state,
  actions,
  timers,
  plan,
  onToggle,
  isToday,
}: {
  task: Task;
  state: AppState;
  actions: AppActions;
  timers: ReturnType<typeof useTimerControls>;
  plan: Plan | null;
  onToggle: (t: Task, d: boolean) => void;
  isToday: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState<null | "priority" | "deadline" | "time" | "move" | "remind" | "schedule">(null);
  const minutes = useTimerMinutes(task);
  const running = !!task.timerStartedAt;
  const move = useMoveTask(state, actions, onToggle);
  const primary = running ? (
    <button className="btn small timer-on" onClick={() => timers.pause(task)} aria-label={`Pause ${task.title}`}>
      Pause · {fmtDuration(minutes)}
    </button>
  ) : isToday ? (
    <button className="btn small primary-soft" onClick={() => timers.start(task)} aria-label={`${minutes > 0 ? "Resume" : "Start"} ${task.title}`}>
      {minutes > 0 ? "Resume" : "Start"}
    </button>
  ) : (
    <button className="btn small ghost" onClick={() => move(task, "today")} aria-label={`Work on ${task.title} today`}>
      Work today
    </button>
  );

  const items: SheetAction[] = [
    { label: "Add time…", run: () => setSheet("schedule") },
    { label: "Log time worked…", run: () => setSheet("time") },
    { label: "Priority…", run: () => setSheet("priority") },
    { label: task.optional ? "Not “if time allows”" : "Mark “if time allows”", run: () => actions.mutate("PATCH", `/api/tasks/${task.id}`, { optional: !task.optional }) },
    { label: task.deadline ? "Change deadline…" : "Set a deadline…", run: () => setSheet("deadline") },
    { label: "Remind me…", run: () => setSheet("remind") },
    { label: "Move…", run: () => setSheet("move") },
    ...(running ? [{ label: "Finish", run: () => timers.finish(task) }] : []),
    { label: "Break it down", run: () => actions.openHelper(task.id, "breakdown") },
    { label: "Help me start", run: () => actions.openHelper(task.id, "assist") },
    {
      label: "Delete",
      danger: true,
      run: () => {
        if (confirm(`Delete “${task.title}”?${blocksOf(plan, task.id).length ? " Its scheduled time will be removed too." : ""}`)) actions.mutate("DELETE", `/api/tasks/${task.id}`);
      },
    },
  ];

  return (
    <li className={`task-row day-task ${running ? "is-running" : ""}`} data-priority={task.priority} data-risk={["overdue", "at_risk"].includes(state.taskMeta[task.id]?.deadlineStatus ?? "") ? "yes" : "no"}>
      <div className="task-main">
        <input type="checkbox" className="check" checked={task.status === "done"} onChange={(e) => onToggle(task, e.target.checked)} aria-label={`Mark ${task.title} done`} />
        <div className="task-text">
          <span className="slot-title">{task.title}</span>
          <TaskMetaChips task={task} state={state} plan={plan} />
          {task.status === "open" && !blocksOf(plan, task.id).length && (
            <button className="link small add-time-link" onClick={() => setSheet("schedule")}>
              + Add time
            </button>
          )}
          <StepList task={task} actions={actions} compact />
        </div>
        <div className="task-actions row gap center-y">
          {primary}
          <button className="icon-btn" aria-label={`More actions for ${task.title}`} onClick={() => setMenu(true)}>
            ⋯
          </button>
        </div>
      </div>
      {menu && <ActionSheet title={task.title} items={items} onClose={() => setMenu(false)} />}
      {sheet === "priority" && (
        <ActionSheet
          title="Priority"
          onClose={() => setSheet(null)}
          items={(["high", "normal", "low"] as TaskPriority[]).map((p) => ({
            label: `${p[0].toUpperCase()}${p.slice(1)}${task.priority === p ? " ✓" : ""}`,
            run: () => actions.mutate("PATCH", `/api/tasks/${task.id}`, { priority: p }),
          }))}
        />
      )}
      {sheet === "deadline" && <DeadlineSheet task={task} state={state} actions={actions} onClose={() => setSheet(null)} />}
      {sheet === "schedule" && <ScheduleSheet task={task} state={state} actions={actions} date={isToday ? state.today : state.tomorrow.date} onClose={() => setSheet(null)} />}
      {sheet === "remind" && <ReminderSheet state={state} actions={actions} task={task} onClose={() => setSheet(null)} />}
      {sheet === "time" && <AddTimeSheet task={task} state={state} actions={actions} onClose={() => setSheet(null)} />}
      {sheet === "move" && (
        <MoveSheet
          title={task.title}
          choices={isToday ? ["later_today", "tomorrow", "pick", "someday", "done"] : ["today", "tomorrow", "pick", "someday", "done"]}
          minDate={state.today}
          onClose={() => setSheet(null)}
          onPick={(c, d) => {
            setSheet(null);
            move(task, c, d);
          }}
        />
      )}
    </li>
  );
}

/** "Add time": give a task a time on this day. Optional; tasks have no time until you do. */
export function ScheduleSheet({ task, state, actions, date, onClose }: { task: Task; state: AppState; actions: AppActions; date: string; onClose: () => void }) {
  const nowM = toMin(state.now);
  const first = date === state.today ? Math.min(23 * 60, Math.ceil((nowM + 5) / 15) * 15) : 9 * 60;
  const [start, setStart] = useState(`${String(Math.floor(first / 60)).padStart(2, "0")}:${String(first % 60).padStart(2, "0")}`);
  const [minutes, setMinutes] = useState(task.estimateMinutes ?? 60);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    const r = await call(actions, "POST", `/api/tasks/${task.id}/schedule`, { date, start, minutes });
    if (r.ok) {
      actions.toast({ text: `“${task.title}” scheduled.` });
      onClose();
    } else setError(r.err.message);
  };
  return (
    <FormSheet title={`Add time · ${task.title}`} onClose={onClose}>
      <div className="sheet-form">
        <p className="muted small sheet-note">
          {date === state.today ? "Today" : "Tomorrow"}. This only sets when you plan to work on it; you can still start it any time.
        </p>
        <label className="field">
          <span>Start</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <div className="field">
          <span>How long</span>
          <div className="chips" role="group" aria-label="How long">
            {[15, 30, 45, 60, 90, 120].map((m) => (
              <button key={m} type="button" className={`chip small-chip ${minutes === m ? "selected" : ""}`} aria-pressed={minutes === m} onClick={() => setMinutes(m)}>
                {fmtDuration(m)}
              </button>
            ))}
          </div>
        </div>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="row gap wrap">
          <button className="btn primary" disabled={!start} onClick={save}>
            Add to {date === state.today ? "today" : "tomorrow"}
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </FormSheet>
  );
}

function DeadlineSheet({ task, state, actions, onClose }: { task: Task; state: AppState; actions: AppActions; onClose: () => void }) {
  const [date, setDate] = useState(task.deadline ?? "");
  const [time, setTime] = useState(task.deadlineTime ?? "");
  const save = async (clear = false) => {
    const ok = await actions.mutate("PATCH", `/api/tasks/${task.id}`, clear ? { deadline: null } : { deadline: date, deadlineTime: time || null });
    if (ok) onClose();
  };
  return (
    <FormSheet title="Deadline" onClose={onClose}>
      <p className="muted small sheet-note">A deadline is not a scheduled time. It only warns you if the work won’t fit.</p>
      <div className="sheet-form">
        <label className="field">
          <span>Date</span>
          <input type="date" min={state.today} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Time (optional)</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <button className="btn primary" disabled={!date} onClick={() => save()}>
          Save deadline
        </button>
        {task.deadline && (
          <button className="btn ghost" onClick={() => save(true)}>
            Remove deadline
          </button>
        )}
      </div>
    </FormSheet>
  );
}

/** "I forgot to start the timer": minutes, or from–to. Overlaps and duplicates are caught by the server. */
export function AddTimeSheet({ task, state, actions, onClose }: { task: Task; state: AppState; actions: AppActions; onClose: () => void }) {
  const [mode, setMode] = useState<"minutes" | "range">("minutes");
  const [mins, setMins] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const body = mode === "minutes" ? { minutes: Math.round(Number(mins)) } : { from, to };
  const ready = mode === "minutes" ? Number(mins) >= 1 : !!from && !!to;
  const save = async (force = false) => {
    const r = await call(actions, "POST", `/api/tasks/${task.id}/time`, { ...body, ...(force ? { force: true } : {}) });
    if (r.ok) {
      actions.toast({ text: `Recorded time on “${task.title}”.` });
      onClose();
    } else if (r.err.code === "session_conflict") setConflict(r.err.message);
    else actions.toast({ text: r.err.message, tone: "error" });
  };
  void state;
  return (
    <FormSheet title={`Add time · ${task.title}`} onClose={onClose}>
      <div className="sheet-form">
        <div className="segmented" role="tablist" aria-label="How to enter the time">
          <button role="tab" aria-selected={mode === "minutes"} className={mode === "minutes" ? "active" : ""} onClick={() => setMode("minutes")}>
            How long
          </button>
          <button role="tab" aria-selected={mode === "range"} className={mode === "range" ? "active" : ""} onClick={() => setMode("range")}>
            From – to
          </button>
        </div>
        {mode === "minutes" ? (
          <label className="field">
            <span>Minutes worked today</span>
            <input type="number" min={1} max={1440} inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value)} />
          </label>
        ) : (
          <div className="row gap">
            <label className="field grow">
              <span>From</span>
              <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="field grow">
              <span>To</span>
              <input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
        )}
        {conflict && (
          <div className="error-box" role="alert">
            {conflict}
          </div>
        )}
        <div className="row gap wrap">
          <button className="btn primary" disabled={!ready} onClick={() => save(false)}>
            Record time
          </button>
          {conflict && (
            <button className="btn" onClick={() => save(true)}>
              Record anyway
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
        <p className="muted small">Saved as “reported” time, separate from timer time.</p>
      </div>
    </FormSheet>
  );
}

// ---------- the list for one day ----------

export function DayTasks({
  state,
  actions,
  date,
  plan,
  onToggle,
  timers,
  empty,
}: {
  state: AppState;
  actions: AppActions;
  date: string;
  plan: Plan | null;
  onToggle: (t: Task, d: boolean) => void;
  timers: ReturnType<typeof useTimerControls>;
  empty: string;
}) {
  const isToday = date === state.today;
  const day = state.days.find((d) => d.date === date);
  const byId = useMemo(() => new Map(state.tasks.map((t) => [t.id, t])), [state.tasks]);
  const listed = (day?.openIds ?? []).map((id) => byId.get(id)).filter(Boolean) as Task[];
  // An overdue deadline stays visible on today's list until the user decides about it.
  const overdue = isToday
    ? state.tasks.filter(
        (t) => t.type === "action" && t.status === "open" && state.taskMeta[t.id]?.deadlineStatus === "overdue" && !listed.some((x) => x.id === t.id),
      )
    : [];
  const tasks = sortTasks([...listed, ...overdue], state.taskMeta, plan);
  return (
    <div className="card day-tasks">
      <div className="row between center-y">
        <h3 className="h3">{isToday ? "Today’s tasks" : date === state.tomorrow.date ? "Tomorrow’s tasks" : "Tasks"}</h3>
        <span className="muted small">{tasks.length ? `${tasks.length} open` : ""}</span>
      </div>
      <WorkloadLine state={state} date={date} />
      {tasks.length ? (
        <ul className="task-list">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} state={state} actions={actions} timers={timers} plan={plan} onToggle={onToggle} isToday={isToday} />
          ))}
        </ul>
      ) : (
        <p className="muted small">{empty}</p>
      )}
      <AddTask actions={actions} plannedDate={date} />
    </div>
  );
}

/** One muted line: counts, estimated work (unknowns separate) and free time. */
export function WorkloadLine({ state, date }: { state: AppState; date: string }) {
  const d = state.days.find((x) => x.date === date);
  if (!d || !d.openIds.length) return null;
  const parts = [`${d.openIds.length} task${d.openIds.length === 1 ? "" : "s"}`];
  if (d.remainingMinutes) parts.push(`${fmtDuration(d.remainingMinutes)} estimated${d.unknownEstimates ? ` (${d.unknownEstimates} without estimate)` : ""}`);
  else if (d.unknownEstimates) parts.push(`${d.unknownEstimates} without estimate`);
  if (d.availableMinutes) parts.push(`${fmtDuration(d.availableMinutes)} available`);
  return <p className="muted small workload">{parts.join(" · ")}</p>;
}

// ---------- current focus (only while a timer runs) ----------

const DOUBT_TEXT: Record<string, string> = {
  other_device: "started on another device",
  long_absence: "you’ve been away for hours",
  too_long: "it has run much longer than expected",
  crossed_day: "it started on an earlier day",
  past_day_end: "it ran past the end of your day",
};

export function FocusCard({ state, actions, timers }: { state: AppState; actions: AppActions; timers: ReturnType<typeof useTimerControls> }) {
  const run = state.running;
  const task = run ? state.tasks.find((t) => t.id === run.taskId) : undefined;
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);
  const [stopping, setStopping] = useState(false);
  if (!run || !task) return null;
  const elapsed = Math.max(0, Math.round((serverNowMs() - new Date(run.startedAt).getTime()) / 60000));
  const startedAt = new Date(run.startedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: state.timezone });
  return (
    <div className={`card focus-card ${run.doubt ? "warn" : "live"}`} aria-live="polite">
      <div className="eyebrow">Current focus</div>
      <strong className="now-title">{task.title}</strong>
      <p className="now-sub">
        {run.doubt ? `Running since ${startedAt} — ${DOUBT_TEXT[run.doubt]}.` : `Running · ${fmtDuration(elapsed)} (since ${startedAt})`}
      </p>
      {run.doubt && <p className="muted small">That’s {fmtDuration(elapsed)} so far. It won’t count as verified until you confirm it.</p>}
      <div className="row gap wrap now-actions">
        {run.doubt ? (
          <>
            <button className="btn primary" onClick={() => actions.mutate("POST", `/api/tasks/${task.id}/still-working`)}>
              Still working
            </button>
            <button className="btn" onClick={() => setStopping(true)}>
              Stop and set time…
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => timers.pause(task)}>
              Pause
            </button>
            <button className="btn primary" onClick={() => timers.finish(task)}>
              Finish
            </button>
          </>
        )}
      </div>
      {stopping && <StopWithTime task={task} elapsed={elapsed} actions={actions} onClose={() => setStopping(false)} />}
    </div>
  );
}

function StopWithTime({ task, elapsed, actions, onClose }: { task: Task; elapsed: number; actions: AppActions; onClose: () => void }) {
  const [minutes, setMinutes] = useState(String(Math.min(elapsed, 120)));
  const n = Math.round(Number(minutes));
  const stop = async (resolution: Record<string, unknown>, finish: boolean) => {
    const r = await call(actions, "POST", finish ? `/api/tasks/${task.id}/finish` : `/api/tasks/${task.id}/timer`, finish ? { resolution } : { action: "stop", resolution });
    if (!r.ok) return actions.toast({ text: r.err.message, tone: "error" });
    onClose();
  };
  return (
    <FormSheet title="How long did you really work?" onClose={onClose}>
      <div className="sheet-form">
        <label className="field">
          <span>Minutes on “{task.title}”</span>
          <input type="number" min={1} max={1440} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </label>
        <button className="btn primary" disabled={!(n >= 1)} onClick={() => stop({ minutes: n }, false)}>
          Stop and record {n >= 1 ? fmtDuration(n) : "time"}
        </button>
        <button className="btn" onClick={() => stop({ keep: true }, false)}>
          Stop and keep {fmtDuration(elapsed)}
        </button>
        <button className="btn ghost danger-text" onClick={() => stop({ discard: true }, false)}>
          Stop and discard the time
        </button>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </FormSheet>
  );
}

// ---------- the single contextual banner ----------

/** At most one banner at a time, in order of how much it matters. */
export function ContextBanner({ state, actions, timers, onWrap }: { state: AppState; actions: AppActions; timers: ReturnType<typeof useTimerControls>; onWrap?: () => void }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [checking, setChecking] = useState<WorkSession | null>(null);
  const [overrun, setOverrun] = useState<{ preview: OverrunPreview; key: string } | null>(null);
  const run = state.running;
  const runTask = run ? state.tasks.find((t) => t.id === run.taskId) : undefined;
  const titleOf = (id: string) => state.tasks.find((t) => t.id === id)?.title ?? "a task";

  let banner: ReactNode = null;
  if (state.checks.length) {
    const total = state.checks.reduce((a, s) => a + s.minutes, 0);
    const s = state.checks[0];
    banner = (
      <>
        <span>
          <strong>Needs a check:</strong> {fmtDuration(total)} on “{titleOf(s.taskId)}”{state.checks.length > 1 ? ` and ${state.checks.length - 1} more` : ""} isn’t counted yet.
        </span>
        <button className="btn small" onClick={() => setChecking(s)}>
          Check
        </button>
      </>
    );
  } else if (run && runTask && !run.doubt) {
    // The planned time for this task has ended but the timer is still going.
    const mine = blocksOf(state.plan, runTask.id);
    const ended = mine.length > 0 && mine.every((b) => toMin(b.end) <= toMin(state.now));
    const key = `${runTask.id}|${mine.at(-1)?.end}`;
    if (ended && dismissed !== key) {
      banner = (
        <>
          <span>
            <strong>Planned time ended</strong> for “{runTask.title}” at {fmtTime(mine.at(-1)!.end)}.
          </span>
          <span className="row gap wrap">
            <button
              className="btn small"
              onClick={async () => {
                const r = await call(actions, "GET", `/api/tasks/${runTask.id}/overrun?minutes=15`);
                const pv: OverrunPreview | undefined = r.ok ? r.res.preview : undefined;
                // Nothing in the way: keeping going changes nothing. Otherwise show what it would affect.
                if (pv && (pv.fixed || pv.shifted.length || pv.dropped.length)) setOverrun({ preview: pv, key });
                else setDismissed(key);
              }}
            >
              Keep going
            </button>
            <button className="btn small primary" onClick={() => timers.finish(runTask)}>
              Finish
            </button>
            <button className="btn small ghost" onClick={() => timers.pause(runTask)}>
              Pause
            </button>
          </span>
        </>
      );
    }
  } else if (!run && state.plan && state.suggestion) {
    const w = state.plan.window;
    const nowMin = toMin(state.now);
    if (nowMin >= toMin(w.start) && nowMin < toMin(w.end)) {
      const next = state.plan.blocks.filter((b) => toMin(b.start) > nowMin && (WORK.has(b.kind) || b.kind === "meeting")).sort((a, b) => toMin(a.start) - toMin(b.start))[0];
      const free = (next ? toMin(next.start) : toMin(w.end)) - nowMin;
      const t = state.tasks.find((x) => x.id === state.suggestion!.taskId);
      const key = `free|${t?.id}|${Math.floor(nowMin / 30)}`;
      const scheduledNow = t ? blocksOf(state.plan, t.id).some((b) => toMin(b.start) <= nowMin && nowMin < toMin(b.end)) : false;
      if (t && free >= 20 && !scheduledNow && dismissed !== key) {
        banner = (
          <>
            <span>
              {fmtDuration(Math.min(free, 240))} free: start “{t.title}”? <span className="muted small">{state.suggestion.reason}</span>
            </span>
            <span className="row gap">
              <button className="btn small primary" onClick={() => timers.start(t)}>
                Start
              </button>
              <button className="btn small ghost" onClick={() => setDismissed(key)}>
                Not now
              </button>
            </span>
          </>
        );
      }
    }
  }
  if (!banner && !checking && onWrap && !run) {
    banner = (
      <>
        <span>
          <strong>The day is over.</strong> Wrap up to review what happened and decide what carries over.
        </span>
        <button className="btn small primary" onClick={onWrap}>
          Wrap up
        </button>
      </>
    );
  }
  if (!banner && !checking && !overrun) return null;
  return (
    <>
      {overrun && (
        <OverrunSheet
          preview={overrun.preview}
          title={runTask?.title ?? "this task"}
          onClose={() => setOverrun(null)}
          onLeave={() => {
            setDismissed(overrun.key);
            setOverrun(null);
          }}
          onExtend={async () => {
            const r = await call(actions, "POST", `/api/tasks/${overrun.preview.taskId}/overrun`, { minutes: overrun.preview.minutes });
            if (!r.ok) actions.toast({ text: r.err.message, tone: "error", details: r.err.details });
            else setDismissed(overrun.key);
            setOverrun(null);
          }}
        />
      )}
      {banner && (
        <div className="banner" role="status">
          {banner}
        </div>
      )}
      {checking && <CheckSheet session={checking} title={titleOf(checking.taskId)} actions={actions} onClose={() => setChecking(null)} />}
    </>
  );
}

/** Keeping going past a planned block: say exactly what it would touch, and offer safe choices. */
function OverrunSheet({ preview, title, onClose, onLeave, onExtend }: { preview: OverrunPreview; title: string; onClose: () => void; onLeave: () => void; onExtend: () => void }) {
  return (
    <FormSheet title={`Keep going on “${title}”`} onClose={onClose}>
      <div className="sheet-form">
        {preview.fixed && (
          <p className="small">
            <strong>{preview.fixed.title}</strong> {preview.fixed.pinned ? "(a time you set) " : ""}starts at {fmtTime(preview.fixed.start)}.{" "}
            {preview.capped ? `Extending would stop there, at ${fmtTime(preview.newEnd!)}.` : ""}
          </p>
        )}
        {preview.shifted.length > 0 && (
          <div className="small">
            Would move later:
            <ul className="plain-list">
              {preview.shifted.map((s, i) => (
                <li key={i}>
                  {s.title}: {fmtTime(s.from)} → {fmtTime(s.to)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {preview.dropped.length > 0 && (
          <div className="small">
            No longer fits today (stays on your list, unscheduled):
            <ul className="plain-list">
              {preview.dropped.map((d, i) => (
                <li key={i}>{d.title}</li>
              ))}
            </ul>
          </div>
        )}
        <button className="btn primary" onClick={onExtend}>
          Extend to {fmtTime(preview.newEnd!)} and update the plan
        </button>
        <button className="btn" onClick={onLeave}>
          Keep going, leave the plan as it is
        </button>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </FormSheet>
  );
}

// ---------- earlier unfinished work ----------

export function CarryLine({ state, actions, onToggle, children }: { state: AppState; actions: AppActions; onToggle: (t: Task, d: boolean) => void; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ids = state.newDay?.unfinishedTaskIds ?? state.carryovers;
  const move = useMoveTask(state, actions, onToggle);
  const [moving, setMoving] = useState<Task | null>(null);
  if (!ids.length) return null;
  const tasks = ids.map((id) => state.tasks.find((t) => t.id === id)).filter(Boolean) as Task[];
  return (
    <div className="carry">
      <button className="carry-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        {ids.length} from earlier {open ? "⌄" : "›"}
      </button>
      {open &&
        (state.newDay ? (
          children
        ) : (
          <ul className="plain-list">
            {tasks.map((t) => (
              <li key={t.id} className="row between center-y">
                <span>{t.title}</span>
                <span className="row gap">
                  <button className="btn small" onClick={() => move(t, "today")}>
                    Today
                  </button>
                  <button className="btn small ghost" onClick={() => setMoving(t)}>
                    Move…
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ))}
      {moving && (
        <MoveSheet
          title={moving.title}
          choices={["today", "tomorrow", "pick", "someday", "done", "drop"]}
          minDate={state.today}
          onClose={() => setMoving(null)}
          onPick={(c, d) => {
            const t = moving;
            setMoving(null);
            move(t, c, d);
          }}
        />
      )}
    </div>
  );
}
