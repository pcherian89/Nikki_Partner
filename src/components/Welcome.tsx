import { useRef, useState } from "react";
import type { AppState } from "../../shared/types";
import type { AppActions } from "../App";
import { fmtDate } from "../util";
import { NikkiFigure } from "./Avatar";

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
        {returning && summary && (
          <p className="welcome-summary">
            {summary}{" "}
            <button className="link" onClick={() => actions.setView("today")}>
              Go to today's plan →
            </button>
          </p>
        )}
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
          <button className="btn primary" onClick={() => submit()} disabled={!text.trim() || liveOff}>
            Plan my day
          </button>
        </div>
      </div>

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
        ) : liveOff ? (
          <>
            <strong>Live AI isn't set up yet</strong> — the server has no ANTHROPIC_API_KEY. You can still add tasks and context
            by hand, or{" "}
            <button className="link" onClick={() => actions.switchWorkspace("demo")}>
              try Demo mode
            </button>
            .
          </>
        ) : (
          <>
            <strong>Live AI.</strong> Nikki's replies come from Claude ({state.model}). Your saved context is sent with each
            request so Nikki can plan — it isn't used to train the model.
          </>
        )}
      </div>
      </div>
    </div>
  );
}
