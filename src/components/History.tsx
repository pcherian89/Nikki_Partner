import { useState } from "react";
import type { AppState, HistoryItem, HistoryStatus } from "../../shared/types";
import type { AppActions } from "../App";
import { fmtDuration, fmtRange } from "../util";

export const STATUS_LABEL: Record<HistoryStatus, string> = {
  done: "Done",
  partial: "Partly done",
  skipped: "Skipped",
  rescheduled: "Rescheduled",
  unconfirmed: "Not recorded",
  replaced: "Not needed",
  removed: "Removed",
  planned: "Planned",
};

/** "Did it / Partly / Didn't do" for one planned block. Recording an answer never changes the task itself. */
export function OutcomeButtons({ item, actions, onDone }: { item: HistoryItem; actions: AppActions; onDone?: () => void }) {
  const [partly, setPartly] = useState(false);
  const [minutes, setMinutes] = useState("");
  const record = async (outcome: "done" | "partial" | "skipped", mins?: number) => {
    const ok = await actions.mutate("POST", "/api/history/outcome", { outcomes: [{ taskId: item.taskId, start: item.start, outcome, ...(mins != null ? { minutes: mins } : {}) }] });
    if (ok) {
      setPartly(false);
      onDone?.();
    }
  };
  return (
    <div className="outcome-buttons" role="group" aria-label={`What happened with ${item.title}`}>
      <button className="btn small" onClick={() => record("done")}>
        Did it
      </button>
      <button className="btn small ghost" onClick={() => setPartly((p) => !p)} aria-expanded={partly}>
        Partly
      </button>
      <button className="btn small ghost" onClick={() => record("skipped")}>
        Didn't do
      </button>
      {partly && (
        <form
          className="outcome-minutes"
          onSubmit={(e) => {
            e.preventDefault();
            record("partial", minutes ? Number(minutes) : undefined);
          }}
        >
          <input type="number" inputMode="numeric" min={0} max={600} placeholder="min" value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Minutes worked" />
          <button className="btn small primary">Save</button>
        </form>
      )}
    </div>
  );
}

function Row({ item, actions }: { item: HistoryItem; actions: AppActions }) {
  const [editing, setEditing] = useState(false);
  const open = item.status === "unconfirmed";
  return (
    <li className={`history-row status-${item.status}`}>
      <div className="history-main">
        <span className="history-time">{fmtRange(item.start, item.end)}</span>
        <span className="history-title">{item.title}</span>
      </div>
      <div className="history-meta">
        <span className={`tag ${open ? "warn" : "subtle"}`}>{STATUS_LABEL[item.status]}</span>
        {item.workedMinutes > 0 && <span className="muted small">Worked {fmtDuration(item.workedMinutes)}</span>}
        {item.note && <span className="muted small">{item.note}</span>}
        {!open && ["done", "partial", "skipped"].includes(item.status) && (
          <button className="link small" onClick={() => setEditing((e) => !e)}>
            Change
          </button>
        )}
      </div>
      {(open || editing) && <OutcomeButtons item={item} actions={actions} onDone={() => setEditing(false)} />}
    </li>
  );
}

/**
 * The day's record: planned blocks that began or were rescheduled, with what happened to each. Collapsed so it
 * doesn't compete with today's task list. Nothing in it is deleted by replanning.
 */
export function EarlierToday({ state, actions }: { state: AppState; actions: AppActions }) {
  const items = state.history;
  if (!items.length) return null;
  const open = items.filter((i) => i.status === "unconfirmed").length;
  return (
    <details className="card history-card" open={open > 0}>
      <summary className="section-summary">
        Earlier today ({items.length}){open > 0 ? ` · ${open} not recorded` : ""}
      </summary>
      <ul className="history-list">
        {items.map((i) => (
          <Row key={i.key} item={i} actions={actions} />
        ))}
      </ul>
    </details>
  );
}

/** For the wrap-up: just the blocks still waiting for an answer. */
export function UnrecordedBlocks({ state, actions }: { state: AppState; actions: AppActions }) {
  const items = state.history.filter((i) => i.status === "unconfirmed");
  if (!items.length) return null;
  return (
    <div className="wrap-section">
      <div className="eyebrow">Not recorded ({items.length})</div>
      <p className="muted small">What happened in these planned blocks? Nothing is assumed.</p>
      <ul className="history-list">
        {items.map((i) => (
          <Row key={i.key} item={i} actions={actions} />
        ))}
      </ul>
    </div>
  );
}
