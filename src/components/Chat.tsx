import { useEffect, useRef, useState } from "react";
import type { AppState, ChatMessage, Receipt, WeeklyFacts } from "../../shared/types";
import type { AppActions, PendingSend } from "../App";
import { Avatar } from "./Avatar";
import { MicButton } from "./Voice";
import { ProposalCard } from "./ProposalCard";

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

  // Chat shows today's conversation; earlier days are one tap away. (Nikki's own memory of them is unchanged.)
  const [showEarlier, setShowEarlier] = useState(false);
  const dayOf = (iso: string) => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: state.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
    } catch {
      return iso.slice(0, 10);
    }
  };
  const isTodays = (m: ChatMessage) => dayOf(m.createdAt) === state.today || (!!state.proposal && m.meta.proposalId === state.proposal.id);
  const visible = showEarlier ? state.messages : state.messages.filter(isTodays);
  const earlierCount = state.messages.length - state.messages.filter(isTodays).length;

  const last = visible[visible.length - 1];
  const lastNikki = last?.role === "assistant" && !last.meta.system ? last : null;
  const quickReplies = lastNikki
    ? lastNikki.meta.quickReplies?.length
      ? lastNikki.meta.quickReplies
      : lastNikki.meta.exampleAnswer
        ? [lastNikki.meta.exampleAnswer]
        : []
    : [];

  // "/" jumps to the message box from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && !el.isContentEditable) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const proposal = state.proposal;

  return (
    <div className="chat">
      <div className="chat-head">
        <Avatar size={44} glow />
        <div>
          <div className="chat-title">Nikki</div>
          {(demo || liveOff) && <div className="chat-sub">{demo ? "Demo mode · scripted, not AI" : "Live AI not set up"}</div>}
        </div>
      </div>

      <div className="chat-scroll" aria-live="polite" ref={scrollRef}>
        {earlierCount > 0 && (
          <button className="link small earlier-link" onClick={() => setShowEarlier((v) => !v)}>
            {showEarlier ? "Hide earlier days" : `Show earlier messages (${earlierCount})`}
          </button>
        )}
        {visible.length === 0 && !pending && (
          <div className="empty-chat">
            <p>{state.messages.length ? "A fresh day. What's on your mind?" : "What do you need to plan?"}</p>
          </div>
        )}
        {visible.map((m) => (
          <div key={m.id}>
            <Message m={m} state={state} actions={actions} />
            {proposal && m.meta.proposalId === proposal.id && !proposal.plan && proposal.status === "pending" && (
              // Small changes (take off today, move, delete…) can be confirmed right here.
              <div className="inline-proposal">
                <ProposalCard state={state} proposal={proposal} actions={actions} onShowPlan={onShowPlan} />
              </div>
            )}
            {proposal && m.meta.proposalId === proposal.id && proposal.plan && (
              <button className="proposal-link" onClick={onShowPlan}>
                <span>
                  <strong>{proposal.kind === "replan" ? "Updated plan ready" : proposal.plan.date === state.tomorrow.date ? "Plan for tomorrow ready" : "Plan ready"}</strong>
                  <span className="muted small block">Review and confirm</span>
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
                <div className="bubble">Replan{pending.remainingUntil ? ` (until ${pending.remainingUntil})` : ""}</div>
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
        {lastNikki && !pending && quickReplies.length > 0 && (
          <div className="suggest-row" aria-label="Quick replies">
            {quickReplies.map((q) => (
              <button key={q} className="chip quick" onClick={() => submit(q)}>
                {q}
              </button>
            ))}
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
          placeholder={liveOff ? "Live AI isn't configured — add an API key or use Demo mode." : "Tell Nikki anything…"}
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
        {!liveOff && (
          <MicButton
            onText={(t) => setText((cur) => (cur ? `${cur.trimEnd()} ${t}` : t))}
            onError={(msg) => actions.toast({ text: msg, tone: "error" })}
          />
        )}
        <button className="btn primary" disabled={!text.trim() || !!pending || liveOff}>
          {pending ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}

const mins = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}m` : ""}` : `${n}m`);

/** The weekly review's numbers, counted by the app. Nikki's words interpret them; these are the facts. */
function WeeklyCard({ w }: { w: WeeklyFacts }) {
  return (
    <div className="weekly-card">
      <div className="eyebrow">
        The numbers · {w.from} to {w.to}
      </div>
      <ul className="plain-list compact">
        <li>
          <strong>Done:</strong> {w.completed.length} task{w.completed.length === 1 ? "" : "s"} · {w.recordedMinutes ? `${mins(w.recordedMinutes)} recorded` : "no time recorded"}
        </li>
        <li>
          <strong>Planned, not finished:</strong> {w.unfinished.length}
        </li>
        {w.projects.map((p) => (
          <li key={p.id}>
            <strong>{p.title}:</strong> {p.minutesThisWeek ? `${mins(p.minutesThisWeek)} this week` : "no time recorded"} · {p.tasksDoneThisWeek} task{p.tasksDoneThisWeek === 1 ? "" : "s"} done
            {p.overdueMilestones ? ` · ${p.overdueMilestones} milestone overdue` : ""}
          </li>
        ))}
        <li>
          <strong>Coming up:</strong> {w.upcoming.deadlines.length} deadline{w.upcoming.deadlines.length === 1 ? "" : "s"}, {w.upcoming.commitments} commitment{w.upcoming.commitments === 1 ? "" : "s"}
        </li>
      </ul>
      {w.dataGaps.length > 0 && (
        <div className="weekly-gaps small">
          <strong>What this can’t see:</strong>
          <ul>
            {w.dataGaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** What the app actually did — the record, whatever the reply says. */
function Receipts({ receipts, actions }: { receipts: Receipt[]; actions: AppActions }) {
  const [undone, setUndone] = useState<Record<string, boolean>>({});
  return (
    <ul className="receipts">
      {receipts.map((r, i) => (
        <li key={i} className={r.ok ? "ok" : "fail"}>
          <span className="receipt-mark" aria-hidden>
            {r.ok ? "✓" : "✕"}
          </span>
          <span className="receipt-text">{undone[r.undoId ?? ""] ? `Undone: ${r.text}` : r.text}</span>
          {r.ok && r.undoId && !undone[r.undoId] && (
            <button
              className="link small"
              onClick={async () => {
                if (await actions.mutate("POST", `/api/undo/${r.undoId}`)) setUndone({ ...undone, [r.undoId!]: true });
              }}
            >
              Undo
            </button>
          )}
          {!r.ok && r.retry && (
            <button className="link small" onClick={() => actions.mutate("POST", "/api/actions", r.retry)}>
              {r.retryLabel ?? "Do it anyway"}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Message({ m, state, actions }: { m: ChatMessage; state: AppState; actions: AppActions }) {
  if (m.meta.system) {
    return <div className="system-note">{m.text}</div>;
  }
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
        {m.meta.weekly ? <WeeklyCard w={m.meta.weekly} /> : null}
        {m.meta.receipts?.length ? <Receipts receipts={m.meta.receipts} actions={actions} /> : null}
        {(captured.length > 0 && !m.meta.receipts?.length) || meetings.length > 0 ? (
          <div className="captured">
            <span className="muted small">Added:</span>
            <div className="chips">
              {!m.meta.receipts?.length && captured.map((t) => (
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
        ) : null}
        {m.meta.notes?.length ? (
          <details className="notes">
            <summary>Notes ({m.meta.notes.length})</summary>
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
