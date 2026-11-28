import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { AppActions } from "../App";
import { fmtRecent, More, useStepUp } from "./Safety";

/**
 * Context → Accounts (Phase 1A). Connect a personal Gmail and its Google Calendar, read-only. One reusable
 * "Add a Google account" flow: safety checks first (a tested, off-device backup), then the address and space,
 * then Google's own screen. Each account shows what Nikki can and can't do with it, when it last updated, and
 * Reconnect / Disconnect.
 */

type Any = any;

const STATUS: Record<string, { text: string; tone: string }> = {
  connected: { text: "Connected", tone: "ok" },
  needs_reconnect: { text: "Sign in again", tone: "warn" },
  revoked: { text: "Disconnected", tone: "muted" },
  not_connected: { text: "Not finished", tone: "muted" },
  error: { text: "Problem", tone: "warn" },
};

const REASONS: Record<string, string> = {
  denied: "You cancelled on Google's screen, so nothing was connected.",
  wrong_account: "That was a different Google account, so nothing was connected.",
  managed_account: "Only personal Gmail accounts can be connected at this stage.",
  state_expired: "The sign-in took longer than 10 minutes. Please start again.",
  no_scopes: "Neither Gmail nor Calendar was allowed on Google's screen. Start again and tick both boxes.",
};

export function AccountsCard({ actions }: { actions: AppActions }) {
  const [st, setSt] = useState<Any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { run, modal } = useStepUp();

  const load = useCallback(async () => {
    try {
      setSt(await api<Any>("GET", "/api/google/status"));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Coming back from Google: say what happened once, then tidy the address bar.
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const g = q.get("google");
    if (!g) return;
    if (g === "connected") setBanner({ ok: true, text: "Connected. Nikki is reading your calendar now; email search is ready." });
    else setBanner({ ok: false, text: REASONS[q.get("reason") ?? ""] ?? "Google sign-in didn't finish, so nothing was connected." });
    q.delete("google");
    q.delete("reason");
    history.replaceState(null, "", `${location.pathname}?${q}${location.hash}`);
    const t = setTimeout(load, 2500); // the first calendar read runs in the background
    return () => clearTimeout(t);
  }, [load]);

  const call = async (method: string, url: string, body?: unknown, okText?: string, key?: string) => {
    setBusy(key ?? url);
    try {
      const r = await run(() => api<Any>(method, url, body));
      if (r?.recovery) setSt(r);
      else await load();
      if (okText) actions.toast({ text: okText });
      return r;
    } catch (e) {
      if ((e as ApiError).code !== "cancelled") actions.toast({ text: (e as Error).message, tone: "error", details: (e as ApiError).details });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const connect = async (body: Record<string, unknown>) => {
    const r = await call("POST", "/api/google/connect", body, undefined, "connect");
    if (r?.url) location.href = r.url;
  };

  if (err) return <section className="card" id="accounts"><h2 className="h3">Accounts</h2><p className="error-text small">{err}</p></section>;
  if (!st) return <section className="card" id="accounts"><h2 className="h3">Accounts</h2><p className="muted small">Loading…</p></section>;

  const live = st.accounts;
  return (
    <section className="card accounts-card" id="accounts">
      {modal}
      <h2 className="h3">Accounts</h2>
      <p className="muted small">Let Nikki read your Gmail and Google Calendar. Read-only: Nikki can’t send, delete or change anything there.</p>
      {banner && (
        <p className={`account-banner ${banner.ok ? "ok" : "warn"}`} role="status">
          {banner.text}
        </p>
      )}

      {live.length > 0 && (
        <ul className="account-list">
          {live.map((a: Any) => (
            <AccountRow key={a.id} a={a} st={st} busy={busy} call={call} onReconnect={() => connect({ accountId: a.id })} />
          ))}
        </ul>
      )}
      {live.length === 0 && !adding && <p className="empty-note small">No accounts connected yet.</p>}

      {st.overlappingFeeds?.length > 0 && (
        <p className="small muted note-line">
          Your calendar link “{st.overlappingFeeds.map((f: Any) => f.name).join("”, “")}” shows the same Google calendar. Events now appear once; you can unlink it under Calendars if you like.
        </p>
      )}

      {adding ? (
        <AddAccount st={st} busy={busy} call={call} onConnect={connect} onCancel={() => setAdding(false)} />
      ) : (
        <button className="btn" onClick={() => setAdding(true)}>
          Add a Google account
        </button>
      )}

      <More title="What Nikki can and can’t do" hint="read-only">
        <p className="small"><strong>Can:</strong> {st.permissions.can.join("; ")}.</p>
        <p className="small"><strong>Can’t:</strong> {st.permissions.cannot.join("; ")}.</p>
        <p className="small muted">
          Nikki doesn’t keep a copy of your mailbox. Searches are fetched from Gmail when you ask; only the sender, subject and date of results shown in chat are kept, for 30 days. Calendar events for the next month are copied so your plans can work around them. Disconnecting removes those copies; your own Nikki tasks and notes stay.
        </p>
        <p className="small muted">
          Google requests today: {st.callsToday.gmail} Gmail, {st.callsToday.calendar} Calendar (Nikki stops at {st.callsToday.limit.toLocaleString()} each; Google’s free allowance is 5,000). Reading email and calendar uses no AI credit.
        </p>
      </More>
    </section>
  );
}

function AccountRow({ a, st, busy, call, onReconnect }: { a: Any; st: Any; busy: string | null; call: Any; onReconnect: () => void }) {
  const s = STATUS[a.status] ?? { text: a.status, tone: "muted" };
  const space = st.spaces.find((x: Any) => x.id === a.spaceId)?.name ?? a.spaceId;
  const [sel, setSel] = useState<string[]>(a.calendars.filter((c: Any) => c.selected).map((c: Any) => c.id));
  useEffect(() => setSel(a.calendars.filter((c: Any) => c.selected).map((c: Any) => c.id)), [a.calendars]);
  const changed = JSON.stringify([...sel].sort()) !== JSON.stringify(a.calendars.filter((c: Any) => c.selected).map((c: Any) => c.id).sort());
  const connected = a.status === "connected";
  return (
    <li className="account-row">
      <div className="account-head">
        <span className="account-id">
          <strong>{a.email ?? a.label}</strong>
          {a.displayName && <span className="muted small"> · {a.displayName}</span>}
        </span>
        <span className={`status-pill ${s.tone}`}>{s.text}</span>
      </div>
      <p className="small muted account-meta">
        Personal Google account · {space} space
        {a.services.length > 0 && ` · ${a.services.map((x: string) => (x === "gmail" ? "Gmail" : "Calendar")).join(" and ")}, read-only`}
        {" · no agents"}
      </p>
      {connected && (
        <p className="small muted account-meta">
          {a.syncStatus === "unavailable" ? "Calendar not available from Google yet. Gmail still works, any calendar link you added is still used, and Nikki tries again every 6 hours." : a.syncStatus === "syncing" || a.syncStatus === "waiting" ? "Reading your calendar…" : a.lastSyncAt ? `Calendar updated ${fmtRecent(a.lastSyncAt)}` : "Calendar not read yet"}
          {" · email is fetched when you ask"}
        </p>
      )}
      {a.lastError && a.syncStatus !== "unavailable" && <p className="small warn-text">{a.lastError}</p>}
      <div className="row gap wrap account-actions">
        {connected && (
          <button className="btn small" disabled={busy === `sync:${a.id}`} onClick={() => call("POST", `/api/google/accounts/${a.id}/sync`, {}, "Updated from Google.", `sync:${a.id}`)}>
            {busy === `sync:${a.id}` ? "Updating…" : "Update now"}
          </button>
        )}
        {a.status !== "connected" && (
          <button className="btn small primary" disabled={!st.recovery.ready || !st.setup.configured || busy === "connect"} onClick={onReconnect} title={!st.recovery.ready ? "Finish the safety checks first (Add a Google account)." : undefined}>
            {a.status === "needs_reconnect" ? "Sign in again" : a.status === "revoked" ? "Reconnect" : "Connect"}
          </button>
        )}
        {(connected || a.status === "needs_reconnect") && (
          <button
            className="btn small ghost subtle-danger"
            onClick={() =>
              confirm(
                `Disconnect ${a.email}?\n\nNikki will stop reading it, cancel its access at Google, and remove its copies of your Google calendar events and email results. Your Nikki tasks, plans and notes stay. Nothing in Gmail or Google Calendar changes.`,
              ) && call("POST", `/api/google/accounts/${a.id}/disconnect`, {}, "Disconnected. Nothing in Gmail or Calendar was changed.", `disc:${a.id}`)
            }
          >
            Disconnect
          </button>
        )}
        {(a.status === "revoked" || a.status === "not_connected") && (
          <button className="btn small ghost" onClick={() => confirm(`Remove ${a.email ?? a.label} from the list?`) && call("DELETE", `/api/google/accounts/${a.id}`, undefined, "Removed.")}>
            Remove
          </button>
        )}
      </div>
      {connected && a.services.includes("calendar") && a.calendars.length > 0 && (
        <More title="Which calendars to read" hint={`${a.calendars.filter((c: Any) => c.selected).length} of ${a.calendars.length}`}>
          <ul className="plain-list small calendar-pick">
            {a.calendars.map((c: Any) => (
              <li key={c.id}>
                <label className="check-line">
                  <input type="checkbox" disabled={!!c.skippedReason} checked={sel.includes(c.id)} onChange={(e) => setSel(e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} />
                  <span>
                    {c.name}
                    {c.primary && <span className="muted"> · main calendar</span>}
                    {c.skippedReason && <span className="muted"> · {c.skippedReason}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button className="btn small" disabled={!changed || busy === `cals:${a.id}`} onClick={() => call("PATCH", `/api/google/accounts/${a.id}`, { calendars: sel }, "Saved. Calendar updated.", `cals:${a.id}`)}>
            Save choice
          </button>
        </More>
      )}
    </li>
  );
}

function AddAccount({ st, busy, call, onConnect, onCancel }: { st: Any; busy: string | null; call: Any; onConnect: (b: Record<string, unknown>) => void; onCancel: () => void }) {
  const [email, setEmail] = useState("");
  const [space, setSpace] = useState("personal");
  const rec = st.recovery;
  const valid = /^[^\s@]+@(gmail|googlemail)\.com$/i.test(email.trim());
  const latest = rec.latestBackup;

  const download = async () => {
    if (!latest) return;
    const r = await call("POST", `/api/system/backups/${encodeURIComponent(latest.file)}/prepare`, {}, undefined, "download");
    if (r) {
      location.href = `/api/system/backups/${encodeURIComponent(latest.file)}`;
      setTimeout(() => call("GET", "/api/google/status"), 2500);
    }
  };
  const fix: Record<string, ReactNode> = {
    key: null,
    key_saved: (
      <label className="check-line">
        <input type="checkbox" checked={!!rec.keySavedAt} onChange={(e) => call("POST", "/api/google/recovery/key-saved", { saved: e.target.checked })} />
        <span>I’ve saved the encryption key in my password manager</span>
      </label>
    ),
    backup: (
      <button className="btn small" disabled={busy === "/api/system/backups/run"} onClick={() => call("POST", "/api/system/backups/run", {}, "Backup made.")}>
        Make a backup now
      </button>
    ),
    restore: (
      <button className="btn small" disabled={!latest || busy === "/api/google/recovery/check"} onClick={() => call("POST", "/api/google/recovery/check", {}, undefined)}>
        Test a restore
      </button>
    ),
    offsite: (
      <button className="btn small" disabled={!latest || busy === "download"} onClick={download}>
        Download the latest backup
      </button>
    ),
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && rec.ready && st.setup.configured) onConnect({ expectedEmail: email.trim(), spaceId: space });
  };

  return (
    <div className="card inset add-account">
      <h3 className="h4">Add a Google account</h3>
      {!st.setup.configured && (
        <div className="small">
          <p className="warn-text">Google sign-in isn’t set up on the server yet. Nikki will guide you through it step by step.</p>
          <p className="muted">
            Redirect address for Google Cloud: <code className="selectable">{st.setup.redirectUri}</code>
          </p>
        </div>
      )}

      <p className="small"><strong>1. Safety checks</strong> <span className="muted">(needed before Nikki holds a Google sign-in)</span></p>
      <ul className="check-list small">
        {rec.items.map((i: Any) => (
          <li key={i.id} className={i.ok ? "" : "warn"}>
            <span>{i.label}</span>
            {!i.ok && fix[i.id] && <div className="check-fix">{fix[i.id]}</div>}
            {i.ok && i.id === "restore" && rec.restoreCheck && <span className="muted"> · {fmtRecent(rec.restoreCheck.at)}</span>}
            {i.ok && i.id === "offsite" && rec.lastDownloadAt && <span className="muted"> · {fmtRecent(rec.lastDownloadAt)}</span>}
          </li>
        ))}
      </ul>
      {!rec.ready && <p className="small muted">The backup file is encrypted. Keep it on your Mac; it only opens with your encryption key.</p>}

      <form onSubmit={submit}>
        <p className="small"><strong>2. Which account</strong></p>
        <label className="field">
          <span>Gmail address</span>
          <input type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" />
        </label>
        {email.trim() && !valid && <p className="small warn-text">Only personal addresses ending in @gmail.com can be connected at this stage.</p>}
        <label className="field">
          <span>Space</span>
          <select value={space} onChange={(e) => setSpace(e.target.value)}>
            {st.spaces.map((s: Any) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <p className="small"><strong>3. Google’s screen</strong></p>
        <p className="small muted">Choose this account, then allow Gmail (read) and Calendar (read). Nikki asks for nothing else. You’ll come straight back here.</p>
        <div className="row gap wrap">
          <button className="btn primary" disabled={!valid || !rec.ready || !st.setup.configured || busy === "connect"}>
            {busy === "connect" ? "Opening Google…" : "Continue to Google"}
          </button>
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
