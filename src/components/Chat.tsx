import { useEffect, useRef, useState } from "react";
import type { AppState, ChatMessage } from "../../shared/types";
import type { AppActions, PendingSend } from "../App";
import { Avatar } from "./Avatar";

interface Props {
  state: AppState;
  actions: AppActions;
  pending: PendingSend | null;
  sendError: { message: string; send: PendingSend } | null;
  onRetry: () => void;
  onDismissError: () => void;
  composer: { text: string; focusTick: number };
  onShowPlan: () => void;
}

export function Chat({ state, actions, pending, sendError, onRetry, onDismissError, composer, onShowPlan }: Props) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const demo = state.workspace === "demo";
  const liveOff = !demo && !state.liveAvailable;

  useEffect(() => {
    if (composer.focusTick) {
      if (composer.text) setText(composer.text);
      inputRef.current?.focus();
    }
  }, [composer.focusTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, pending, state.proposal?.id]);

  const submit = async (t = text) => {
    const v = t.trim();
    if (!v || pending) return;
    setText("");
    const ok = await actions.send(v);
    if (!ok) setText(v);
  };

  const last = state.messages[state.messages.length - 1];
  const proposal = state.proposal;

  return (
    <div className="chat">
      <div className="chat-head">
        <Avatar size={44} glow />
        <div>
          <div className="chat-title">Nikki</div>
          <div className="chat-sub">{demo ? "Demo mode · scripted, not AI" : liveOff ? "Live AI not configured" : "Your planning partner"}</div>
        </div>
        {demo && (
          <button
            className="btn small ghost push-right"
            onClick={() => {
              if (confirm("Reset the demo? This clears all demo data (your personal data is untouched).")) {
                actions.mutate("POST", "/api/demo/reset");
              }
            }}
          >
            Reset demo
          </button>
        )}
      </div>

      <div className="chat-scroll" aria-live="polite" ref={scrollRef}>
        {state.messages.length === 0 && !pending && (
          <div className="empty-chat">
            <p>Tell me what's on your mind today — everything, in your own words.</p>
          </div>
        )}
        {state.messages.map((m) => (
          <div key={m.id}>
            <Message m={m} state={state} />
            {proposal && m.meta.proposalId === proposal.id && (
              <button className="proposal-link" onClick={onShowPlan}>
                <span>
                  <strong>{proposal.plan ? (proposal.kind === "replan" ? "Proposed update ready" : "Proposed plan ready") : "Suggestions to review"}</strong>
                  <span className="muted small block">Not saved until you confirm · review it in Today's plan</span>
                </span>
                <span aria-hidden>→</span>
              </button>
            )}
          </div>
        ))}
        {pending && (
          <>
            {pending.kind !== "replan" ? (
              <div className="msg user">
                <div className="bubble">{pending.text}</div>
              </div>
            ) : (
              <div className="msg user">
                <div className="bubble">Update my plan{pending.remainingUntil ? ` (until ${pending.remainingUntil})` : ""}</div>
              </div>
            )}
            <div className="msg assistant">
              <Avatar size={28} />
              <div className="bubble typing" aria-label="Nikki is thinking">
                <span />
                <span />
                <span />
              </div>
            </div>
          </>
        )}
        {sendError && !pending && (
          <div className="send-error" role="alert">
            <div>
              <strong>Couldn't get a reply.</strong> {sendError.message}
            </div>
            <div className="row gap">
              <button className="btn small primary" onClick={onRetry}>
                Retry
              </button>
              {sendError.send.kind !== "replan" && (
                <button
                  className="btn small ghost"
                  onClick={() => {
                    setText(sendError.send.text);
                    onDismissError();
                    inputRef.current?.focus();
                  }}
                >
                  Edit message
                </button>
              )}
              <button className="btn small ghost" onClick={onDismissError}>
                Dismiss
              </button>
            </div>
          </div>
        )}
        {demo && last?.role === "assistant" && last.meta.exampleAnswer && !pending && (
          <div className="suggest-row">
            <span className="muted small">Example answer:</span>
            <button className="chip" onClick={() => submit(last.meta.exampleAnswer!)}>
              {last.meta.exampleAnswer}
            </button>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={inputRef}
          rows={2}
          value={text}
          placeholder={liveOff ? "Live AI isn't configured — add an API key or use Demo mode." : "Tell Nikki anything — new tasks, answers, changes…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={liveOff}
          aria-label="Message Nikki"
        />
        <button className="btn primary" disabled={!text.trim() || !!pending || liveOff}>
          {pending ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}

function Message({ m, state }: { m: ChatMessage; state: AppState }) {
  if (m.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{m.meta.kind === "replan" ? `↻ ${m.text}` : m.text}</div>
      </div>
    );
  }
  const captured = (m.meta.capturedTaskIds ?? []).map((id) => state.tasks.find((t) => t.id === id)).filter(Boolean);
  const meetings = (m.meta.addedMeetingIds ?? []).map((id) => state.meetings.find((x) => x.id === id)).filter(Boolean);
  const questions = m.meta.questions ?? [];
  const questionsInText = questions.every((q) => m.text.includes(q));
  return (
    <div className="msg assistant">
      <Avatar size={28} />
      <div className="bubble">
        {m.meta.demo && <div className="demo-tag">Demo reply · scripted</div>}
        <div className="msg-text">{m.text}</div>
        {questions.length > 0 && !questionsInText && (
          <ol className="questions">
            {questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        )}
        {(captured.length > 0 || meetings.length > 0) && (
          <div className="captured">
            <span className="muted small">Saved to your list:</span>
            <div className="chips">
              {captured.map((t) => (
                <span key={t!.id} className={`chip static ${t!.type}`}>
                  {t!.title}
                </span>
              ))}
              {meetings.map((mt) => (
                <span key={mt!.id} className="chip static meeting">
                  {mt!.title} {mt!.start}–{mt!.end}
                </span>
              ))}
            </div>
          </div>
        )}
        {m.meta.notes?.length ? (
          <details className="notes">
            <summary>App checks ({m.meta.notes.length})</summary>
            <ul>
              {m.meta.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}
