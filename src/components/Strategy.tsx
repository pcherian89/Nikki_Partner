import { useState } from "react";
import type { AppState, MemoryItem, MemoryKind, MemoryStatus } from "../../shared/types";
import type { AppActions } from "../App";
import { ActionSheet } from "./MoveSheet";
import { MEMORY_KIND, MEMORY_STATUS } from "./ProposalCard";

const GROUPS: { title: string; kinds: MemoryKind[] }[] = [
  { title: "Focus and priorities", kinds: ["focus", "priority"] },
  { title: "Commitments and goals", kinds: ["commitment", "goal"] },
  { title: "Constraints", kinds: ["constraint"] },
  { title: "Decisions", kinds: ["decision"] },
  { title: "Paused and ideas", kinds: ["paused", "idea"] },
];

/**
 * Everything Nikki remembers about your work beyond your tasks and projects. You can read it, correct it and remove
 * it. Things Nikki adds only appear after you confirm them; tentative things expire for review.
 */
export function StrategyCard({ state, actions }: { state: AppState; actions: AppActions }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<MemoryItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ kind: MemoryKind; text: string }>({ kind: "priority", text: "" });
  const live = state.memory.filter((m) => m.status !== "outdated");
  const outdated = state.memory.filter((m) => m.status === "outdated");
  const patch = (id: string, body: Record<string, unknown>) => actions.mutate("PATCH", `/api/memory/${id}`, body);

  const row = (m: MemoryItem) => (
    <li key={m.id} className={`memory-row ${m.status} ${m.stale ? "stale" : ""}`}>
      {editing === m.id ? (
        <form
          className="row gap wrap"
          onSubmit={async (e) => {
            e.preventDefault();
            if (text.trim() && (await patch(m.id, { text: text.trim() }))) setEditing(null);
          }}
        >
          <input className="grow" value={text} maxLength={300} onChange={(e) => setText(e.target.value)} aria-label="Edit what Nikki remembers" autoFocus />
          <button className="btn small primary">Save</button>
          <button type="button" className="btn small ghost" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="row between gap">
          <span className="memory-text">
            {m.text}
            <span className="task-meta">
              <span className={`tag ${m.status === "confirmed" || m.status === "approved" ? "" : "subtle"}`}>{MEMORY_STATUS[m.status]}</span>
              {m.source === "nikki" && <span className="muted small">suggested by Nikki</span>}
              {m.stale && <span className="tag warn">Needs review</span>}
              {m.reviewAfter && !m.stale && <span className="muted small">review {m.reviewAfter}</span>}
            </span>
            {m.rationale && <span className="muted small block">Why: {m.rationale}</span>}
          </span>
          <span className="row gap center-y">
            {m.stale && (
              <button className="btn small" onClick={() => patch(m.id, { keep: true })}>
                Keep
              </button>
            )}
            <button className="icon-btn" aria-label={`More for: ${m.text}`} onClick={() => setMenu(m)}>
              ⋯
            </button>
          </span>
        </div>
      )}
    </li>
  );

  return (
    <section className="card strategy-card" aria-label="What Nikki remembers">
      <div className="row between center-y">
        <h2 className="h3">What Nikki remembers about your work</h2>
        {!adding && (
          <button className="btn small" onClick={() => setAdding(true)}>
            + Add
          </button>
        )}
      </div>
      <p className="muted small">Your priorities, commitments, constraints and decisions. Tasks, projects and recorded time are kept separately. Nikki only adds something after you confirm it.</p>
      {adding && (
        <form
          className="row gap wrap"
          onSubmit={async (e) => {
            e.preventDefault();
            if (draft.text.trim() && (await actions.mutate("POST", "/api/memory", { kind: draft.kind, text: draft.text.trim() }))) {
              setAdding(false);
              setDraft({ kind: "priority", text: "" });
            }
          }}
        >
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as MemoryKind })} aria-label="Kind">
            {Object.entries(MEMORY_KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <input className="grow" value={draft.text} maxLength={300} onChange={(e) => setDraft({ ...draft, text: e.target.value })} placeholder="e.g. Client work comes first until March" aria-label="What to remember" />
          <button className="btn small primary" disabled={!draft.text.trim()}>
            Add
          </button>
          <button type="button" className="btn small ghost" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </form>
      )}
      {live.length === 0 && !adding && <p className="muted small">Nothing yet. As you talk through priorities and decisions, Nikki may suggest things to remember, and you decide.</p>}
      {GROUPS.map((g) => {
        const items = live.filter((m) => g.kinds.includes(m.kind));
        if (!items.length) return null;
        return (
          <div key={g.title} className="memory-group">
            <div className="eyebrow">{g.title}</div>
            <ul className="plain-list">{items.map(row)}</ul>
          </div>
        );
      })}
      {outdated.length > 0 && (
        <details>
          <summary className="section-summary">No longer true ({outdated.length})</summary>
          <ul className="plain-list">{outdated.map(row)}</ul>
        </details>
      )}
      {menu && (
        <ActionSheet
          title={menu.text.slice(0, 60)}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Edit…",
              run: () => {
                setEditing(menu.id);
                setText(menu.text);
              },
            },
            ...((["confirmed", "tentative", "assumption"] as MemoryStatus[])
              .filter((s) => s !== menu.status)
              .map((s) => ({ label: `Mark as ${MEMORY_STATUS[s].toLowerCase()}`, run: () => patch(menu.id, { status: s }) }))),
            ...(menu.status !== "outdated" ? [{ label: "No longer true", run: () => patch(menu.id, { status: "outdated" }) }] : []),
            { label: "Forget this", danger: true, run: () => actions.mutate("DELETE", `/api/memory/${menu.id}`) },
          ]}
        />
      )}
    </section>
  );
}
