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
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(state.profile));
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

      <form
        className="card context-form"
        onSubmit={(e) => {
          e.preventDefault();
          actions.mutate("PUT", "/api/profile", form).then((ok) => ok && actions.toast({ text: "Context saved." }));
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={form.name} onChange={set("name")} placeholder="What should Nikki call you?" />
        </label>
        <label className="field">
          <span>Businesses and projects</span>
          <textarea rows={3} value={form.projects} onChange={set("projects")} placeholder="One per line — e.g. Revivo IQ (consulting), beta app launch" />
        </label>
        <label className="field">
          <span>Current goals</span>
          <textarea rows={3} value={form.goals} onChange={set("goals")} placeholder="e.g. Land two new clients this quarter" />
        </label>
        <label className="field">
          <span>Main outcome right now</span>
          <input value={form.mainOutcome} onChange={set("mainOutcome")} placeholder="The one result that matters most this season" />
        </label>
        <label className="field">
          <span>Important commitments</span>
          <textarea rows={2} value={form.commitments} onChange={set("commitments")} placeholder="e.g. School pickup 3pm weekdays; Monday team call" />
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
        <label className="field">
          <span>Planning preferences</span>
          <textarea rows={2} value={form.preferences} onChange={set("preferences")} placeholder="e.g. Deep work in the morning; no more than 3 priorities; 10-minute breaks" />
        </label>
        <div className="row gap center-y">
          <button className="btn primary" disabled={!dirty}>
            Save context
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
