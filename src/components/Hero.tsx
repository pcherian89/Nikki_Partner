import type { AppState } from "../../shared/types";
import type { AppActions } from "../App";
import { fmtDate, fmtDuration, toMin } from "../util";
import { Avatar } from "./Avatar";
import { ProgressRing } from "./Today";
import type { useTimerControls } from "./TaskList";

const greeting = (time: string) => (toMin(time) < 5 * 60 ? "Still up" : toMin(time) < 12 * 60 ? "Good morning" : toMin(time) < 18 * 60 ? "Good afternoon" : "Good evening");

/**
 * The top of Today: Nikki says hello, how the day stands, and the one thing worth starting. The wording is fixed
 * (never AI-written) and every number comes from the app's own records.
 */
export function TodayHero({
  state,
  timers,
  menu,
}: {
  state: AppState;
  actions: AppActions;
  timers: ReturnType<typeof useTimerControls>;
  menu: React.ReactNode;
}) {
  const day = state.days[0];
  const open = day?.openIds.length ?? 0;
  const done = day?.doneCount ?? 0;
  const first = state.profile.name.trim().split(/\s+/)[0];
  const meta = state.taskMeta;
  const urgent = state.tasks.filter((t) => t.status === "open" && ["overdue", "at_risk"].includes(meta[t.id]?.deadlineStatus ?? "")).length;
  const next = !state.running && state.suggestion ? state.tasks.find((t) => t.id === state.suggestion!.taskId) : null;

  let line: string;
  if (state.running) line = "You're in the zone. I'll keep the clock for you.";
  else if (open === 0 && done > 0) line = "Everything on today's list is done. Nicely done.";
  else if (open === 0) line = "Nothing on today's list yet. Add a task, or tell me what's on your mind.";
  else if (urgent) line = `${open} on your list — ${urgent} need${urgent === 1 ? "s" : ""} attention first.`;
  else line = `${open} on your list${day.availableMinutes ? ` and about ${fmtDuration(day.availableMinutes)} free` : ""}. Pick any, in any order.`;

  return (
    <section className="hero" aria-label="Today">
      <div className="hero-top">
        <Avatar size={58} glow />
        <div className="hero-text">
          <div className="hero-eyebrow">{fmtDate(state.today)}</div>
          <h2 className="hero-title">
            {greeting(state.now)}
            {first ? `, ${first}` : ""}
          </h2>
          <p className="hero-line">{line}</p>
        </div>
        <div className="hero-side">
          {open + done > 0 && <ProgressRing done={done} total={done + open} size={54} />}
          {menu}
        </div>
      </div>
      {next && (
        <div className="hero-next">
          <span className="hero-next-label">Next up</span>
          <span className="hero-next-title">{next.title}</span>
          <span className="hero-next-why">{state.suggestion!.reason}</span>
          <button className="btn small primary" onClick={() => timers.start(next)} aria-label={`Start ${next.title}`}>
            Start
          </button>
        </div>
      )}
    </section>
  );
}
