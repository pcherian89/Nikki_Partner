import { useEffect, useMemo, useState } from "react";
import type { AppState, Profile } from "../../shared/types";
import { api, browserTimezone } from "../api";
import type { AppActions } from "../App";
import { Avatar } from "./Avatar";

type Form = Omit<Profile, "updatedAt">;

const toForm = (p: Profile): Form => {
  const { updatedAt: _u, ...rest } = p;
  return rest;
};

export function ContextView({ state, actions }: { state: AppState; actions: AppActions }) {
  const [form, setForm] = useState<Form>(toForm(state.profile));
  const [deleteText, setDeleteText] = useState("");
  const SINGLE = ["name", "mainOutcome", "workStart", "workEnd", "timezone"] as const;
  const dirty = SINGLE.some((k) => (form[k] ?? "") !== (state.profile[k] ?? ""));
  useEffect(() => setForm(toForm(state.profile)), [state.profile]);

  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
    } catch {
      return [browserTimezone()];
    }
  }, []);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const demo = state.workspace === "demo";

  const exportData = async () => {
    try {
      const data = await api<unknown>("GET", "/api/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `nikki-${state.workspace}-export-${state.today}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      actions.toast({ text: (e as Error).message, tone: "error" });
    }
  };

  return (
    <div className="page">
      <div className="page-head row gap center-y">
        <Avatar size={56} glow />
        <div>
          <h1 className="h2">My context</h1>
          <p className="muted">Everything here is optional. The more Nikki knows, the less she has to ask.</p>
        </div>
      </div>

      <div className="card memory-note">
        <strong>How Nikki's memory works.</strong> What you save here, your tasks, plans and recent conversation are stored by this app
        in its own database{demo ? " (the separate demo database)" : ""}. When you message Nikki, the relevant parts are sent to the AI model as
        context for that one request. This is not model training — the model doesn't learn or remember anything between requests. Nikki may
        suggest updates from your conversations, but nothing is saved here without your confirmation.
      </div>

      <div className="context-lists">
        <ListField state={state} actions={actions} field="projects" title="Businesses & projects" placeholder="e.g. Revivo IQ — AI consulting" />
        <ListField state={state} actions={actions} field="goals" title="Goals" placeholder="e.g. Land two new clients this quarter" />
        <ListField state={state} actions={actions} field="commitments" title="Regular commitments" placeholder="e.g. School pickup 3pm on weekdays" />
        <ListField state={state} actions={actions} field="preferences" title="Planning preferences" placeholder="e.g. Deep work in the morning" />
      </div>

      <form
        className="card context-form"
        onSubmit={(e) => {
          e.preventDefault();
          const patch = Object.fromEntries(SINGLE.map((k) => [k, form[k]]));
          actions.mutate("PUT", "/api/profile", patch).then((ok) => ok && actions.toast({ text: "Saved." }));
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={form.name} onChange={set("name")} placeholder="What should Nikki call you?" />
        </label>
        <label className="field">
          <span>Main outcome right now</span>
          <input value={form.mainOutcome} onChange={set("mainOutcome")} placeholder="The one result that matters most this season" />
        </label>
        <div className="grid-3">
          <label className="field">
            <span>Usual start</span>
            <input type="time" value={form.workStart} onChange={set("workStart")} />
          </label>
          <label className="field">
            <span>Usual end</span>
            <input type="time" value={form.workEnd} onChange={set("workEnd")} />
          </label>
          <label className="field">
            <span>Timezone</span>
            <select value={form.timezone} onChange={set("timezone")}>
              <option value="">Use this device ({browserTimezone()})</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row gap center-y">
          <button className="btn primary" disabled={!dirty}>
            Save
          </button>
          {dirty && (
            <button type="button" className="btn ghost" onClick={() => setForm(toForm(state.profile))}>
              Discard changes
            </button>
          )}
          <span className="muted small">Using timezone: {state.timezone}</span>
        </div>
      </form>

      <div className="card">
        <h2 className="h3">What Nikki has learned about your pace</h2>
        {state.learning.factor ? (
          <>
            <p className="small">
              Your tasks usually take about <strong>{state.learning.factor}×</strong> their estimate (based on {state.learning.samples}{" "}
              completed tasks). Nikki uses this when building your schedule.
            </p>
            {state.learning.byProject.length > 0 && (
              <ul className="plain-list compact small">
                {state.learning.byProject.map((p) => (
                  <li key={p.project}>
                    {p.project}: about {p.factor}× ({p.samples} tasks)
                  </li>
                ))}
              </ul>
            )}
            {state.learning.recent.length > 0 && (
              <details className="small">
                <summary>Recent examples</summary>
                <ul className="plain-list compact">
                  {state.learning.recent.map((r, i) => (
                    <li key={i}>
                      {r.title}: estimated {r.estimate} min, took {r.actual} min
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ) : (
          <p className="muted small">
            Not enough data yet ({state.learning.samples} of 3 tasks measured). Use the focus timer on a task, or tell Nikki how long a
            finished task really took in “Completed today”. After 3 tasks she starts adjusting your plans.
          </p>
        )}
      </div>

      <div className="card">
        <h2 className="h3">Mode</h2>
        <div className="mode-options">
          <button className={`mode-option ${!demo ? "active" : ""}`} onClick={() => actions.switchWorkspace("personal")}>
            <strong>My workspace{state.liveAvailable ? " · Live AI" : ""}</strong>
            <span className="muted small">
              {state.liveAvailable ? `Replies from Claude (${state.model ?? "configured model"}).` : "Live AI isn't configured on the server yet (no API key). You can still add tasks and context by hand."}
            </span>
          </button>
          <button className={`mode-option ${demo ? "active" : ""}`} onClick={() => actions.switchWorkspace("demo")}>
            <strong>Demo mode</strong>
            <span className="muted small">Scripted example replies — not AI. Uses separate demo data.</span>
          </button>
        </div>
        {demo && (
          <button
            className="btn ghost"
            onClick={() => confirm("Reset the demo? This clears all demo data.") && actions.mutate("POST", "/api/demo/reset")}
          >
            Reset demo data
          </button>
        )}
      </div>

      <div className="card">
        <h2 className="h3">Your data{demo ? " (demo workspace)" : ""}</h2>
        <p className="muted small">Download everything this workspace has stored as a JSON file, or delete it permanently.</p>
        <div className="row gap wrap">
          <button className="btn" onClick={exportData}>
            Export my data
          </button>
        </div>
        <div className="danger-zone">
          <label className="field">
            <span>To delete all data in this workspace, type DELETE</span>
            <input value={deleteText} onChange={(e) => setDeleteText(e.target.value)} placeholder="DELETE" />
          </label>
          <button
            className="btn danger"
            disabled={deleteText !== "DELETE"}
            onClick={async () => {
              const ok = await actions.mutate("DELETE", "/api/data", { confirm: "DELETE" });
              if (ok) {
                setDeleteText("");
                actions.toast({ text: "All data in this workspace was deleted." });
              }
            }}
          >
            Delete all data
          </button>
        </div>
      </div>
      {state.authRequired && (
        <button className="btn ghost" onClick={() => api("POST", "/api/auth/logout").then(() => window.location.reload())}>
          Log out
        </button>
      )}
    </div>
  );
}

type ListKey = "projects" | "goals" | "commitments" | "preferences";

/** A context list shown as removable, editable items. Every change saves immediately. */
function ListField({ state, actions, field, title, placeholder }: { state: AppState; actions: AppActions; field: ListKey; title: string; placeholder: string }) {
  const raw = state.profile[field] ?? "";
  const items = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const [adding, setAdding] = useState("");
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  const save = (next: string[]) => actions.mutate("PUT", "/api/profile", { [field]: next.join("\n") });

  const remove = async (i: number) => {
    const before = raw;
    const ok = await save(items.filter((_, j) => j !== i));
    if (ok) actions.toast({ text: `Removed “${items[i]}”.`, action: { label: "Undo", run: () => actions.mutate("PUT", "/api/profile", { [field]: before }) } });
  };

  return (
    <div className="card list-field">
      <div className="row between center-y">
        <h3 className="h3">{title}</h3>
        <span className="muted small">{items.length || ""}</span>
      </div>
      <ul className="ctx-items">
        {items.map((item, i) => (
          <li key={`${i}-${item}`} className="ctx-item">
            {editIdx === i ? (
              <form
                className="ctx-edit"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const v = editText.trim();
                  if (v && (await save(items.map((x, j) => (j === i ? v : x))))) setEditIdx(null);
                }}
              >
                <input value={editText} onChange={(e) => setEditText(e.target.value)} autoFocus aria-label={`Edit ${item}`} />
                <button className="btn small primary">Save</button>
                <button type="button" className="btn small ghost" onClick={() => setEditIdx(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <button
                  className="ctx-text"
                  title="Click to edit"
                  onClick={() => {
                    setEditIdx(i);
                    setEditText(item);
                  }}
                >
                  {item}
                </button>
                <button className="icon-btn ctx-x" aria-label={`Remove ${item}`} onClick={() => remove(i)}>
                  ×
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="ctx-add"
        onSubmit={async (e) => {
          e.preventDefault();
          const v = adding.trim();
          if (v && (await save([...items, v]))) setAdding("");
        }}
      >
        <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={items.length ? "Add another…" : placeholder} aria-label={`Add to ${title}`} />
        {adding.trim() && <button className="btn small">Add</button>}
      </form>
    </div>
  );
}
