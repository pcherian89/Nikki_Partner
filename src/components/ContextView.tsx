import { NotificationsCard } from "./Reminders";
import { useEffect, useMemo, useState } from "react";
import type { AppState, Profile } from "../../shared/types";
import { api, browserTimezone } from "../api";
import { AutoTextarea } from "./AutoTextarea";
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
          <h1 className="h2">Context</h1>
          <p className="muted small">What Nikki knows about you. All optional.</p>
        </div>
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
          <span>Current priority</span>
          <AutoTextarea value={form.mainOutcome} onChange={(v) => set("mainOutcome")({ target: { value: v } })} placeholder="The one result that matters most this season" />
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
        </div>
      </form>

      <Calendars state={state} actions={actions} />
      <NikkiInCalendar state={state} actions={actions} />
      <NotificationsCard state={state} actions={actions} />

      <div className="card">
        <h2 className="h3">Pace</h2>
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
            finished task really took in “Done today”. After 3 tasks she starts adjusting your plans.
          </p>
        )}
      </div>

      <div className="card">
        <h2 className="h3">Mode</h2>
        <div className="mode-options">
          <button className={`mode-option ${!demo ? "active" : ""}`} onClick={() => actions.switchWorkspace("personal")}>
            <strong>My workspace{state.liveAvailable ? " · Live AI" : ""}</strong>
            <span className="muted small">
              {state.liveAvailable ? "Your own data, with live AI." : "Live AI isn't set up on the server yet. You can still add tasks and context by hand."}
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
        <h2 className="h3">Data{demo ? " · demo" : ""}</h2>
        <p className="muted small">
          Export, import or permanently delete everything stored here.
        </p>
        <div className="row gap wrap">
          <button className="btn" onClick={exportData}>
            Export my data
          </button>
          <label className="btn ghost file-btn">
            Import from a file…
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                let data: unknown;
                try {
                  data = JSON.parse(await file.text());
                } catch {
                  actions.toast({ text: "That file isn't a valid export.", tone: "error" });
                  return;
                }
                if (!confirm("Import this file? It REPLACES everything currently in this workspace (tasks, plans, context, chat).")) return;
                const ok = await actions.mutate("POST", "/api/import", { confirm: "REPLACE", data });
                if (ok) actions.toast({ text: "Data imported." });
              }}
            />
          </label>
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
                <AutoTextarea value={editText} onChange={setEditText} submitOnEnter autoFocus aria-label={`Edit ${item}`} />
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
        <AutoTextarea value={adding} onChange={setAdding} submitOnEnter placeholder={items.length ? "Add another…" : placeholder} aria-label={`Add to ${title}`} />
        {adding.trim() && <button className="btn small">Add</button>}
      </form>
    </div>
  );
}

function timeAgo(iso: string) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** Read-only calendar links (Google / Apple iCloud .ics). */
function Calendars({ state, actions }: { state: AppState; actions: AppActions }) {
  const [name, setName] = useState("Google");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const add = async () => {
    setBusy("add");
    const ok = await actions.mutate("POST", "/api/calendars", { name, url });
    setBusy(null);
    if (ok) {
      setUrl("");
      actions.toast({ text: `${name} calendar linked. Your events now appear in Today, Tomorrow and Week.` });
    }
  };
  return (
    <div className="card calendars">
      <h2 className="h3">Calendars</h2>
      <p className="muted small">
        Your meetings, read-only. Syncs every 15 minutes.
      </p>
      {state.calendars.length > 0 && (
        <ul className="plain-list">
          {state.calendars.map((c) => (
            <li key={c.id} className="calendar-row">
              <span>
                <strong>{c.name}</strong>{" "}
                <span className="muted small">
                  {c.lastError ? (
                    <span className="error-text small">Couldn't sync: {c.lastError}</span>
                  ) : c.lastSyncAt ? (
                    `Synced ${timeAgo(c.lastSyncAt)} · ${c.eventCount} upcoming event${c.eventCount === 1 ? "" : "s"}`
                  ) : (
                    "Waiting for first sync"
                  )}
                </span>
              </span>
              <span className="row gap">
                <button
                  className="btn small ghost"
                  disabled={busy === c.id}
                  onClick={async () => {
                    setBusy(c.id);
                    await actions.mutate("POST", `/api/calendars/${c.id}/sync`, {});
                    setBusy(null);
                  }}
                >
                  {busy === c.id ? "Syncing…" : "Sync now"}
                </button>
                <button
                  className="btn small ghost"
                  onClick={() => confirm(`Unlink “${c.name}”? Its events will be removed from Nikki (your calendar itself is untouched).`) && actions.mutate("DELETE", `/api/calendars/${c.id}`)}
                >
                  Unlink
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="calendar-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) add();
        }}
      >
        <select value={name} onChange={(e) => setName(e.target.value)} aria-label="Calendar type">
          <option>Google</option>
          <option>Apple</option>
          <option>Outlook</option>
          <option>Work</option>
          <option>Personal</option>
        </select>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste your private calendar link (https://… or webcal://…)" aria-label="Calendar link" />
        <button className="btn primary" disabled={!url.trim() || busy === "add"}>
          {busy === "add" ? "Checking…" : "Link"}
        </button>
      </form>
      <details className="small">
        <summary>How do I get my Google link?</summary>
        <ol className="howto">
          <li>
            On a computer, open <strong>calendar.google.com</strong>.
          </li>
          <li>
            On the left, hover over your calendar under <strong>My calendars</strong>, click <strong>⋮</strong> →{" "}
            <strong>Settings and sharing</strong>.
          </li>
          <li>
            Scroll to <strong>Integrate calendar</strong> and copy <strong>Secret address in iCal format</strong> (it ends in
            <code>.ics</code>).
          </li>
          <li>Paste it above and click Link. Keep this link private — anyone with it can see your events.</li>
        </ol>
      </details>
      <details className="small">
        <summary>How do I get my Apple (iCloud) link?</summary>
        <ol className="howto">
          <li>
            On your iPhone open <strong>Calendar</strong> → <strong>Calendars</strong>, tap <strong>ⓘ</strong> next to the calendar.
            On a Mac: in Calendar, right-click the calendar → <strong>Share Calendar…</strong>.
          </li>
          <li>
            Turn on <strong>Public Calendar</strong> and tap <strong>Share Link…</strong> → <strong>Copy</strong> (it starts with
            <code>webcal://</code>).
          </li>
          <li>Paste it above and click Link. "Public" means anyone with the link can view it, so don't share the link.</li>
        </ol>
      </details>
    </div>
  );
}

/** "Nikki in your calendar": a private subscription link for Google / Apple Calendar. */
function NikkiInCalendar({ state, actions }: { state: AppState; actions: AppActions }) {
  const [copied, setCopied] = useState(false);
  const token = state.nikkiFeedToken;
  const url = token ? `${window.location.origin}/cal/${token}.ics` : "";
  const local = /^(localhost|127\.|\[::1\])/.test(window.location.hostname);
  return (
    <div className="card calendars">
      <h2 className="h3">Calendar feed</h2>
      <p className="muted small">
        Shows your confirmed plans in Google or Apple Calendar as a separate “Nikki” calendar.
      </p>
      {!token ? (
        <button className="btn primary" onClick={() => actions.mutate("POST", "/api/calendar-feed", { action: "create" })}>
          Create my calendar link
        </button>
      ) : (
        <>
          <div className="feed-url">
            <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Your Nikki calendar link" />
            <button
              className="btn small"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  actions.toast({ text: "Select the link and copy it.", tone: "error" });
                }
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {local && (
            <p className="small warn-text">
              This link only works once Nikki is hosted online. Your calendar app can't reach this computer, so add it after deploying.
            </p>
          )}
          <p className="muted small">Keep this link private: anyone who has it can see your plans.</p>
          <details className="small">
            <summary>Add it to Google Calendar</summary>
            <ol className="howto">
              <li>
                On a computer, open <strong>calendar.google.com</strong>.
              </li>
              <li>
                On the left, next to <strong>Other calendars</strong>, click <strong>+</strong> → <strong>From URL</strong>.
              </li>
              <li>
                Paste the link and click <strong>Add calendar</strong>. Google refreshes subscribed calendars every few hours, so
                changes can take a while to appear.
              </li>
            </ol>
          </details>
          <details className="small">
            <summary>Add it to Apple Calendar</summary>
            <ol className="howto">
              <li>
                <strong>Mac:</strong> in Calendar, choose <strong>File → New Calendar Subscription…</strong>, paste the link, click
                Subscribe, and set Auto-refresh to every 15 minutes or 5 minutes.
              </li>
              <li>
                <strong>iPhone:</strong> Settings → Apps → Calendar → Calendar Accounts → Add Account → Other →{" "}
                <strong>Add Subscribed Calendar</strong>, then paste the link.
              </li>
            </ol>
          </details>
          <div className="row gap wrap">
            <button
              className="btn small ghost"
              onClick={() =>
                confirm("Reset the link? The old link stops working, and you'll need to add the new one to your calendar again.") &&
                actions.mutate("POST", "/api/calendar-feed", { action: "reset" })
              }
            >
              Reset link
            </button>
            <button
              className="btn small ghost"
              onClick={() => confirm("Turn off the calendar link? Your calendar will stop showing Nikki's plans.") && actions.mutate("POST", "/api/calendar-feed", { action: "disable" })}
            >
              Turn off
            </button>
          </div>
        </>
      )}
    </div>
  );
}
