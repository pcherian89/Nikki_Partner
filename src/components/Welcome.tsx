import { useRef, useState } from "react";
import type { AppState } from "../../shared/types";
import type { AppActions } from "../App";
import { fmtDate, fmtRange, fmtTime, toMin } from "../util";
import { planProgress, ProgressRing } from "./Today";
import { NikkiFigure } from "./Avatar";
import { MicButton } from "./Voice";

export const EXAMPLE_DUMP =
  "I have five hours today, except 2–4 when I have a meeting. I need to finish a proposal, review beta feedback, apply for jobs, and explore a business idea.";

export function Welcome({ state, actions, sendError }: { state: AppState; actions: AppActions; sendError: string | null }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const demo = state.workspace === "demo";
  const liveOff = !demo && !state.liveAvailable;
  const returning = state.hasAnyData;
  const name = state.profile.name;
  const greeting = returning ? (name ? `Welcome back, ${name}.` : "Welcome back.") : name ? `Hi ${name}, I'm Nikki.` : "Hi, I'm Nikki.";
  const openActions = state.tasks.filter((t) => t.type === "action" && t.status === "open").length;
  const summary = state.plan
    ? `Your plan for today is confirmed${state.plan.mainOutcome ? ` — main outcome: ${state.plan.mainOutcome}` : ""}.`
    : state.proposal?.plan
      ? "I have a proposed plan waiting for you to review."
      : openActions
        ? `You have ${openActions} open action${openActions > 1 ? "s" : ""} and no plan for today yet.`
        : "";

  const submit = async (t = text) => {
    if (!t.trim()) return;
    // Show the conversation while Nikki replies.
    actions.setView("today");
    const ok = await actions.send(t.trim());
    if (ok) setText("");
  };

  return (
    <div className="welcome">
      <div className="welcome-figure">
        <NikkiFigure />
      </div>
      <div className="welcome-content">
      <div className="welcome-hero">
        <p className="eyebrow">{fmtDate(state.today)}</p>
        <h1 className="h1">{greeting}</h1>
        {returning && <DailyBrief state={state} actions={actions} summary={summary} />}
        <p className="lead">
          {returning
            ? "Anything new or changed? Tell me in your own words and I'll fold it into your plan."
            : "Tell me everything on your mind — work, commitments, ideas, half-formed plans. I'll ask a couple of questions, suggest what matters most today, and build a realistic schedule you can edit."}
        </p>
      </div>

      <div className="welcome-input card">
        <label htmlFor="dump" className="sr-only">
          What's on your mind?
        </label>
        <textarea
          id="dump"
          ref={ref}
          rows={4}
          placeholder="e.g. I have about 5 hours today and a call at 2. I need to finish the proposal, follow up with two clients, and I keep thinking about a podcast idea…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        {sendError && <p className="error-text" role="alert">{sendError}</p>}
        <div className="row between wrap gap">
          <div className="row gap wrap">
            <button
              className="btn ghost"
              onClick={() => {
                if (demo) submit(EXAMPLE_DUMP);
                else {
                  setText(EXAMPLE_DUMP);
                  ref.current?.focus();
                }
              }}
            >
              Try an example
            </button>
            <button className="btn ghost" onClick={() => ref.current?.focus()}>
              Start with my work
            </button>
          </div>
          <div className="row gap center-y">
          {!liveOff && <MicButton onText={(t) => setText((cur) => (cur ? `${cur.trimEnd()} ${t}` : t))} />}
          <button className="btn primary" onClick={() => submit()} disabled={!text.trim() || liveOff}>
            Plan my day
          </button>
          </div>
        </div>
      </div>

      {(demo || liveOff) && (
        <div className={`mode-note ${demo ? "demo" : ""}`}>
          {demo ? (
            <>
              <strong>Demo mode.</strong> Replies are scripted examples, not AI, and demo data is kept separate from your own.{" "}
              {state.liveAvailable ? (
                <button className="link" onClick={() => actions.switchWorkspace("personal")}>
                  Switch to live AI
                </button>
              ) : (
                <span>Add an API key to enable live AI (see README).</span>
              )}
            </>
          ) : (
            <>
              <strong>Live AI isn't set up yet</strong> — the server has no ANTHROPIC_API_KEY. You can still add tasks and context
              by hand, or{" "}
              <button className="link" onClick={() => actions.switchWorkspace("demo")}>
                try Demo mode
              </button>
              .
            </>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

function DailyBrief({ state, actions, summary }: { state: AppState; actions: AppActions; summary: string }) {
  const plan = state.plan;
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const nowMin = toMin(state.now);
  const nextBlock = plan?.blocks.find(
    (b) => toMin(b.end) > nowMin && (b.kind === "meeting" || ((b.kind === "focus" || b.kind === "task") && b.taskId && byId.get(b.taskId)?.status !== "done")),
  );
  const progress = plan ? planProgress(plan, state.tasks) : null;
  const upcoming = [
    ...state.meetings.filter((m) => toMin(m.start) > nowMin).map((m) => ({ ...m, when: `Today ${fmtTime(m.start)}` })),
    ...state.upcoming.map((m) => ({ ...m, when: `${m.date === state.tomorrow.date ? "Tomorrow" : fmtDate(m.date, false)} · ${fmtTime(m.start)}` })),
  ].slice(0, 3);
  const go = () => actions.setView("today");
  return (
    <div className="brief">
      {summary && <p className="welcome-summary">{summary}</p>}
      <div className="brief-grid">
        <button className="brief-card" onClick={go}>
          <span className="eyebrow">Focus</span>
          <strong>{plan ? (plan.focusTaskId ? byId.get(plan.focusTaskId)?.title : plan.mainOutcome) || plan.mainOutcome : "No plan yet"}</strong>
          <span className="muted small">{plan ? "Today's main focus" : "Tell me about your day below"}</span>
        </button>
        <button className="brief-card" onClick={go}>
          <span className="eyebrow">Next</span>
          <strong>{nextBlock ? (nextBlock.taskId ? byId.get(nextBlock.taskId)?.title : nextBlock.title) : plan ? "Nothing else planned" : "—"}</strong>
          <span className="muted small">{nextBlock ? fmtRange(nextBlock.start, nextBlock.end) : " "}</span>
        </button>
        {progress && progress.total > 0 ? (
          <button className="brief-card ring-card" onClick={go}>
            <ProgressRing done={progress.done} total={progress.total} size={52} />
            <span>
              <span className="eyebrow">Progress</span>
              <span className="muted small block">{progress.done === progress.total ? "All planned work done" : `${progress.total - progress.done} to go`}</span>
            </span>
          </button>
        ) : null}
        <button className="brief-card" onClick={go}>
          <span className="eyebrow">Coming up</span>
          {upcoming.length ? (
            <ul className="brief-list">
              {upcoming.map((m) => (
                <li key={m.id}>
                  <span className="muted small">{m.when}</span> {m.title}
                </li>
              ))}
            </ul>
          ) : (
            <span className="muted small">Nothing scheduled</span>
          )}
        </button>
      </div>
    </div>
  );
}
