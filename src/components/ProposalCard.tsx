import { useEffect, useMemo, useState } from "react";
import type { AppState, PlanBlock, PlanDraft, Proposal } from "../../shared/types";
import { api, ApiError } from "../api";
import type { AppActions } from "../App";
import { capacity, fmtDuration, fmtRange, taskById, toMin } from "../util";

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  projects: "Businesses & projects",
  goals: "Goals",
  mainOutcome: "Main outcome",
  commitments: "Commitments",
  workStart: "Usual start time",
  workEnd: "Usual end time",
  timezone: "Timezone",
  preferences: "Planning preferences",
};

const CHANGE_LABELS: Record<string, string> = {
  update: "Update",
  complete: "Mark done",
  waiting: "Mark waiting",
  blocked: "Mark blocked",
  reopen: "Reopen",
  delete: "Delete",
};

export function ProposalCard({
  state,
  proposal,
  actions,
  onShowPlan,
}: {
  state: AppState;
  proposal: Proposal;
  actions: AppActions;
  onShowPlan: () => void;
}) {
  const [draft, setDraft] = useState<PlanDraft | null>(proposal.plan ? structuredClone(proposal.plan) : null);
  const [edited, setEdited] = useState(false);
  const [accepted, setAccepted] = useState<Set<string>>(new Set(proposal.taskChanges.map((c) => c.id)));
  const [errors, setErrors] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(proposal.plan ? structuredClone(proposal.plan) : null);
    setEdited(false);
    setErrors(null);
  }, [proposal.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const tasks = useMemo(() => taskById(state.tasks), [state.tasks]);
  const stale = proposal.status === "stale";
  const pendingSuggestions = proposal.contextSuggestions.filter((s) => s.status === "pending");

  const updateBlock = (id: string, patch: Partial<PlanBlock>) => {
    if (!draft) return;
    setDraft({ ...draft, blocks: draft.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
    setEdited(true);
  };
  const removeBlock = (id: string) => {
    if (!draft) return;
    setDraft({ ...draft, blocks: draft.blocks.filter((b) => b.id !== id) });
    setEdited(true);
  };

  const confirm = async () => {
    setBusy(true);
    setErrors(null);
    try {
      const r = await api("POST", `/api/proposals/${proposal.id}/confirm`, {
        plan: edited && draft ? draft : undefined,
        acceptedTaskChangeIds: [...accepted],
      });
      actions.setState(r.state);
      if (draft) {
        actions.toast({ text: `Plan confirmed${r.state.plan ? ` (version ${r.state.plan.version})` : ""}.`, action: { label: "View plan", run: onShowPlan } });
        onShowPlan();
      } else actions.toast({ text: "Changes applied." });
    } catch (e) {
      const err = e as ApiError;
      setErrors(err.details?.length ? err.details : [err.message]);
      if (err.code === "stale") actions.mutate("GET", "/api/state");
    } finally {
      setBusy(false);
    }
  };

  const diff = useMemo(() => {
    if (!draft || !state.plan) return null;
    const key = (b: PlanBlock) => b.taskId ?? `${b.kind}:${b.title}`;
    const now = toMin(state.now);
    const oldFuture = state.plan.blocks.filter((b) => b.kind !== "meeting" && toMin(b.end) > now);
    const newBlocks = draft.blocks.filter((b) => b.kind !== "meeting");
    const lines: { type: "add" | "remove" | "move"; text: string }[] = [];
    for (const n of newBlocks) {
      const o = oldFuture.find((x) => key(x) === key(n));
      if (!o) lines.push({ type: "add", text: `${n.title} ${fmtRange(n.start, n.end)}` });
      else if (o.start !== n.start || o.end !== n.end) lines.push({ type: "move", text: `${n.title}: ${fmtRange(o.start, o.end)} → ${fmtRange(n.start, n.end)}` });
    }
    for (const o of oldFuture) {
      if (!newBlocks.some((n) => key(n) === key(o)) && (o.kind === "focus" || o.kind === "task")) {
        lines.push({ type: "remove", text: `${o.title} ${fmtRange(o.start, o.end)}` });
      }
    }
    return lines;
  }, [draft, state.plan, state.now]);

  const cap = draft ? capacity(draft) : null;
  const overBudget = cap && cap.work > draft!.workBudgetMinutes;

  return (
    <div className={`proposal card ${stale ? "is-stale" : ""}`}>
      <div className="proposal-head">
        <div>
          <div className="eyebrow">{proposal.kind === "replan" ? "Proposed update" : draft ? "Proposed plan" : "Suggested changes"}</div>
          {draft && (
            <input
              className="outcome-input"
              value={draft.mainOutcome}
              aria-label="Main outcome for today"
              onChange={(e) => {
                setDraft({ ...draft, mainOutcome: e.target.value });
                setEdited(true);
              }}
            />
          )}
        </div>
        <span className="pill">{stale ? "Out of date" : "Not saved yet"}</span>
      </div>

      {stale && <p className="error-text">This proposal is for an earlier day or an older plan. Ask Nikki for a fresh one.</p>}

      {draft && (
        <>
          <div className="priorities">
            {draft.focusTaskId && (
              <div className="priority focus">
                <span className="tag">Main focus</span>
                <strong>{tasks.get(draft.focusTaskId)?.title ?? "Unknown task"}</strong>
                {draft.focusWhy && <p className="why">{draft.focusWhy}</p>}
              </div>
            )}
            {draft.supporting.map((s) => (
              <div className="priority" key={s.taskId}>
                <span className="tag subtle">Supporting</span>
                <strong>{tasks.get(s.taskId)?.title ?? "Unknown task"}</strong>
                {s.why && <p className="why">{s.why}</p>}
              </div>
            ))}
          </div>

          <div className="blocks-edit">
            {draft.blocks.map((b) => (
              <div key={b.id} className={`block-row kind-${b.kind}`}>
                {b.kind === "meeting" ? (
                  <span className="time-fixed">{fmtRange(b.start, b.end)}</span>
                ) : (
                  <span className="time-edit">
                    <input type="time" value={b.start} aria-label={`${b.title} start`} onChange={(e) => updateBlock(b.id, { start: e.target.value })} />
                    <span>–</span>
                    <input type="time" value={b.end} aria-label={`${b.title} end`} onChange={(e) => updateBlock(b.id, { end: e.target.value })} />
                  </span>
                )}
                <span className="block-title">
                  {b.title}
                  {b.kind === "meeting" && <span className="tag subtle">Fixed</span>}
                </span>
                {b.kind !== "meeting" ? (
                  <button className="icon-btn" aria-label={`Remove ${b.title}`} onClick={() => removeBlock(b.id)}>
                    ×
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>

          {cap && (
            <div className="capacity small">
              <span>Work {fmtDuration(cap.work)} of {fmtDuration(draft.workBudgetMinutes)} budget</span>
              <span>Breaks {fmtDuration(cap.breaks)}</span>
              <span>Buffer {fmtDuration(cap.buffer)}</span>
              <span>
                Window {fmtRange(draft.window.start, draft.window.end)}
              </span>
              {overBudget && <span className="warn">Over budget</span>}
            </div>
          )}

          {diff && diff.length > 0 && (
            <div className="diff">
              <div className="eyebrow">Changes to your current plan</div>
              <ul>
                {diff.map((d) => (
                  <li key={d.type + d.text} className={`diff-${d.type}`}>
                    {d.type === "add" ? "+ " : d.type === "remove" ? "− " : "↔ "}
                    {d.text}
                  </li>
                ))}
              </ul>
              <p className="muted small">Completed work and fixed meetings stay as they are.</p>
            </div>
          )}

          {draft.deferred.length > 0 && (
            <details className="deferred">
              <summary>What waits ({draft.deferred.length})</summary>
              <ul>
                {draft.deferred.map((d) => (
                  <li key={d.taskId}>
                    <strong>{tasks.get(d.taskId)?.title ?? "Unknown"}</strong> — <span className="muted">{d.why}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {(draft.reasons.length > 0 || draft.assumptions.length > 0) && (
            <details className="reasons" open>
              <summary>Why this plan</summary>
              <ul>
                {draft.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
                {draft.assumptions.map((a) => (
                  <li key={a} className="assumption">
                    Assumption: {a}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {proposal.taskChanges.length > 0 && (
        <div className="task-changes">
          <div className="eyebrow">Changes to saved tasks</div>
          {proposal.taskChanges.map((c) => (
            <label key={c.id} className="check-row">
              <input
                type="checkbox"
                checked={accepted.has(c.id)}
                onChange={(e) => {
                  const next = new Set(accepted);
                  if (e.target.checked) next.add(c.id);
                  else next.delete(c.id);
                  setAccepted(next);
                }}
              />
              <span>
                <strong>{CHANGE_LABELS[c.change]}</strong>: {tasks.get(c.taskId)?.title ?? c.taskId}
                {c.title ? ` → “${c.title}”` : ""}
                {c.estimateMinutes ? ` (${fmtDuration(c.estimateMinutes)})` : ""}
                <span className="muted"> — {c.reason}</span>
              </span>
            </label>
          ))}
        </div>
      )}

      {pendingSuggestions.length > 0 && (
        <div className="suggestions">
          <div className="eyebrow">Save to My context?</div>
          {pendingSuggestions.map((s) => (
            <div key={s.id} className="suggestion">
              <div>
                <strong>{FIELD_LABELS[s.field] ?? s.field}:</strong> {s.value}
                <div className="muted small">{s.reason}</div>
              </div>
              <div className="row gap">
                <button className="btn small" onClick={() => actions.mutate("POST", `/api/proposals/${proposal.id}/suggestions/${s.id}`, { action: "save" })}>
                  Save
                </button>
                <button className="btn small ghost" onClick={() => actions.mutate("POST", `/api/proposals/${proposal.id}/suggestions/${s.id}`, { action: "dismiss" })}>
                  Not now
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {proposal.warnings.length > 0 && (
        <details className="notes">
          <summary>App checks ({proposal.warnings.length})</summary>
          <ul>
            {proposal.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      {errors && (
        <div className="error-box" role="alert">
          <strong>Can't confirm yet:</strong>
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {stale && (
        <div className="row gap">
          <button className="btn ghost" onClick={() => actions.mutate("POST", `/api/proposals/${proposal.id}/discard`)}>
            Dismiss
          </button>
        </div>
      )}
      {(draft || proposal.taskChanges.length > 0) && !stale && (
        <div className="row gap wrap proposal-actions">
          <button className="btn primary" onClick={confirm} disabled={busy}>
            {busy ? "Saving…" : draft ? (edited ? "Confirm edited plan" : "Confirm plan") : "Apply changes"}
          </button>
          {edited && (
            <button
              className="btn ghost"
              onClick={() => {
                setDraft(proposal.plan ? structuredClone(proposal.plan) : null);
                setEdited(false);
                setErrors(null);
              }}
            >
              Undo edits
            </button>
          )}
          <button className="btn ghost" onClick={() => actions.mutate("POST", `/api/proposals/${proposal.id}/discard`)} disabled={busy}>
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
