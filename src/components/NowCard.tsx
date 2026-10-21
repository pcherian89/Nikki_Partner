import { useState } from "react";
import type { AppState, Plan, Task } from "../../shared/types";
import type { AppActions } from "../App";
import { Avatar } from "./Avatar";
import { MoveSheet } from "./MoveSheet";
import { TimerButton, useTimerMinutes } from "./TaskTools";
import { useMoveTask } from "./Today";
import { fmtDuration, fmtRange, fmtTime, toMin } from "../util";

const WORK = new Set(["focus", "task"]);

export type DayPhase =
  | { kind: "plan"; open: number }
  | { kind: "upcoming"; task: Task; start: string; end: string; left: number }
  | { kind: "now"; task: Task; start: string; end: string; minsLeft: number; left: number; slipped: string | null }
  | { kind: "slipped"; task: Task; end: string; overBy: number }
  | { kind: "behind"; count: number }
  | { kind: "done"; total: number }
  | { kind: "dayEnd"; unfinished: number }
  | { kind: "closed"; tomorrowCount: number; tomorrowFirst: string | null };

/** Where the day is right now — one moment, one next action. Pure and deterministic (no AI). */
export function dayPhase(state: AppState): DayPhase {
  const plan = state.plan;
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  if (state.wrapUpToday) {
    const tp = state.tomorrow.plan;
    const work = tp?.blocks.filter((b) => WORK.has(b.kind) && b.taskId) ?? [];
    return { kind: "closed", tomorrowCount: new Set(work.map((b) => b.taskId)).size, tomorrowFirst: work[0]?.start ?? null };
  }
  if (!plan) return { kind: "plan", open: state.tasks.filter((t) => t.type === "action" && t.status === "open").length };
  const now = toMin(state.now);
  const work = plan.blocks.filter((b) => WORK.has(b.kind) && b.taskId && tasks.has(b.taskId));
  const ids = new Set(work.map((b) => b.taskId!));
  const open = (id: string) => tasks.get(id)!.status !== "done";
  const unfinishedIds = [...ids].filter(open);
  if (ids.size && !unfinishedIds.length) return { kind: "done", total: ids.size };
  if (now >= toMin(plan.window.end)) return { kind: "dayEnd", unfinished: unfinishedIds.length };
  // Work whose time has passed and isn't finished (and isn't coming up again later today).
  const futureIds = new Set(work.filter((b) => toMin(b.end) > now).map((b) => b.taskId!));
  const slipped = work.filter((b) => toMin(b.end) <= now && open(b.taskId!) && !futureIds.has(b.taskId!));
  const slippedIds = [...new Set(slipped.map((b) => b.taskId!))];
  if (slippedIds.length >= 2) return { kind: "behind", count: slippedIds.length };
  const current = work.find((b) => toMin(b.start) <= now && now < toMin(b.end) && open(b.taskId!));
  const remainingAfter = (from: number) => new Set(work.filter((b) => toMin(b.start) >= from && open(b.taskId!)).map((b) => b.taskId)).size;
  if (slippedIds.length === 1 && !current) {
    const b = slipped.filter((x) => x.taskId === slippedIds[0]).pop()!;
    return { kind: "slipped", task: tasks.get(b.taskId!)!, end: b.end, overBy: now - toMin(b.end) };
  }
  if (current) {
    return {
      kind: "now",
      task: tasks.get(current.taskId!)!,
      start: current.start,
      end: current.end,
      minsLeft: toMin(current.end) - now,
      left: remainingAfter(toMin(current.end)),
      slipped: slippedIds.length ? tasks.get(slippedIds[0])!.title : null,
    };
  }
  const next = work.find((b) => toMin(b.start) > now && open(b.taskId!));
  if (next) return { kind: "upcoming", task: tasks.get(next.taskId!)!, start: next.start, end: next.end, left: remainingAfter(toMin(next.end)) };
  return { kind: "dayEnd", unfinished: unfinishedIds.length };
}

const more = (n: number) => (n === 0 ? "Last one today." : `${n} more after this.`);

/**
 * The top of Today: Nikki says where the day stands and offers the one action that matters now.
 * Her face appears here because this is her speaking; the lines are fixed, not AI-written.
 */
export function NowCard({
  state,
  actions,
  plan,
  onToggle,
  onReplan,
  onWrap,
}: {
  state: AppState;
  actions: AppActions;
  plan: Plan | null;
  onToggle: (t: Task, d: boolean) => void;
  onReplan: () => void;
  onWrap: () => void;
}) {
  const p = dayPhase(state);
  const [moving, setMoving] = useState<Task | null>(null);
  const move = useMoveTask(state, actions, onToggle);

  let eyebrow = "";
  let title: React.ReactNode = null;
  let line = "";
  let body: React.ReactNode = null;
  let tone = "";
  switch (p.kind) {
    case "plan":
      eyebrow = "No plan yet";
      title = p.open ? `${p.open} open action${p.open > 1 ? "s" : ""}` : "Nothing planned";
      line = "Tell me your hours and what's on your plate, and I'll draft the day.";
      body = (
        <button className="btn primary" onClick={() => actions.focusComposer(p.open ? "Let's plan today. " : "")}>
          Plan today
        </button>
      );
      break;
    case "upcoming":
      eyebrow = `Next up · ${fmtTime(p.start)}`;
      title = p.task.title;
      line = `${fmtRange(p.start, p.end)}. ${more(p.left)}`;
      body = <StartRow task={p.task} actions={actions} label="Start now" />;
      break;
    case "now":
      eyebrow = `Now · ${fmtDuration(p.minsLeft)} left`;
      title = p.task.title;
      line = p.slipped ? `${more(p.left)} “${p.slipped}” also needs a new time — see below.` : `On track. ${more(p.left)}`;
      tone = "live";
      body = (
        <div className="row gap wrap">
          <button className="btn primary" onClick={() => onToggle(p.task, true)}>
            Done
          </button>
          <TimerButton task={p.task} actions={actions} />
        </div>
      );
      break;
    case "slipped":
      eyebrow = "Not finished";
      title = p.task.title;
      line = `Its time ended at ${fmtTime(p.end)}. Done, or move it?`;
      tone = "warn";
      body = (
        <div className="row gap wrap">
          <button className="btn primary" onClick={() => onToggle(p.task, true)}>
            Done
          </button>
          <button className="btn" onClick={() => setMoving(p.task)}>
            Move…
          </button>
        </div>
      );
      break;
    case "behind":
      eyebrow = `Behind · ${p.count} tasks`;
      title = "The rest of the day no longer fits";
      line = `${p.count} tasks ran out of time. I can rework what's left of today.`;
      tone = "warn";
      body = (
        <button className="btn primary" onClick={onReplan}>
          Replan rest of day
        </button>
      );
      break;
    case "done":
      eyebrow = "All done";
      title = `${p.total} of ${p.total} done`;
      line = "Everything planned for today is done.";
      tone = "good";
      body = (
        <button className="btn primary" onClick={onWrap}>
          Wrap up
        </button>
      );
      break;
    case "dayEnd":
      eyebrow = "Day's end";
      title = p.unfinished ? `${p.unfinished} task${p.unfinished > 1 ? "s" : ""} not finished` : "Planned time is over";
      line = p.unfinished ? "Wrap up to decide where they go." : "Wrap up to close the day.";
      body = (
        <button className="btn primary" onClick={onWrap}>
          Wrap up
        </button>
      );
      break;
    case "closed":
      eyebrow = "Wrapped up";
      title = "Day closed";
      line = p.tomorrowCount
        ? `Tomorrow: ${p.tomorrowCount} task${p.tomorrowCount > 1 ? "s" : ""}${p.tomorrowFirst ? `, first at ${fmtTime(p.tomorrowFirst)}` : ""}.`
        : "Tomorrow isn't planned yet.";
      tone = "good";
      body = (
        <div className="row gap wrap">
          {!state.tomorrow.plan && (
            <button className="btn primary" onClick={() => actions.focusComposer("Let's plan tomorrow. ")}>
              Plan tomorrow
            </button>
          )}
          <button className="btn ghost" onClick={onWrap}>
            Edit wrap-up
          </button>
        </div>
      );
      break;
  }
  void plan;

  return (
    <div className={`card now-card ${tone}`} aria-live="polite">
      <div className="now-head">
        <Avatar size={36} />
        <div className="now-text">
          <div className="eyebrow">{eyebrow}</div>
          <strong className="now-title">{title}</strong>
          <p className="now-sub">{line}</p>
        </div>
      </div>
      {p.kind === "now" && <ProgressBar start={p.start} end={p.end} now={state.now} />}
      {(p.kind === "now" || p.kind === "upcoming") && <StepsHint task={p.task} />}
      <div className="now-actions">{body}</div>
      {moving && (
        <MoveSheet
          title={moving.title}
          choices={["later_today", "tomorrow", "pick", "someday"]}
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

function StartRow({ task, actions, label }: { task: Task; actions: AppActions; label: string }) {
  const minutes = useTimerMinutes(task);
  if (task.timerStartedAt || minutes > 0) return <TimerButton task={task} actions={actions} />;
  return (
    <button className="btn primary" onClick={() => actions.mutate("POST", `/api/tasks/${task.id}/timer`, { action: "start" })}>
      {label}
    </button>
  );
}

function ProgressBar({ start, end, now }: { start: string; end: string; now: string }) {
  const pct = Math.max(0, Math.min(100, ((toMin(now) - toMin(start)) / Math.max(1, toMin(end) - toMin(start))) * 100));
  return (
    <div className="now-progress" aria-hidden>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function StepsHint({ task }: { task: Task }) {
  const next = task.steps.find((s) => !s.done);
  if (!next) return null;
  const done = task.steps.filter((s) => s.done).length;
  return (
    <p className="now-step small">
      Step {done + 1} of {task.steps.length}: {next.title}
    </p>
  );
}
