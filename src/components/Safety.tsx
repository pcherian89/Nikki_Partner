import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { AppActions } from "../App";

/**
 * Phase 0 screens: security and devices, the notification centre (inbox + approvals), AI usage and budget,
 * agents and the emergency stop, activity, backups and (future) connections. They read /api/system/* and always
 * show the personal workspace's system state.
 */

type Any = any; // the overview is a plain JSON snapshot; fields are read defensively below

const PARAM_LABEL: Record<string, string> = { title: "What", date: "Date", time: "Time", estimateMinutes: "Estimate (minutes)", body: "Message", to: "To" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const money = (n: number) => `$${(n ?? 0).toFixed(2)}`;
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

/** Calls the API; if the server asks for a fresh password check, shows the prompt and retries once. */
function useStepUp() {
  const [ask, setAsk] = useState<{ resolve: (ok: boolean) => void; twoFactor: boolean } | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>, twoFactor = false): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "reauth_required") throw e;
      const ok = await new Promise<boolean>((resolve) => setAsk({ resolve, twoFactor }));
      if (!ok) throw new ApiError("Cancelled.", 0, "cancelled");
      return fn();
    }
  }, []);
  const modal = ask ? <StepUpModal twoFactor={ask.twoFactor} onDone={(ok) => (ask.resolve(ok), setAsk(null))} /> : null;
  return { run, modal };
}

function StepUpModal({ twoFactor, onDone }: { twoFactor: boolean; onDone: (ok: boolean) => void }) {
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("POST", "/api/auth/verify", { password: pw, code });
      onDone(true);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  };
  return (
    <div className="modal-backdrop" onClick={() => onDone(false)}>
      <form className="modal card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="h3">Confirm it’s you</h2>
        <p className="small muted">This step is sensitive, so Nikki asks for your password again on this device. It stays confirmed for 15 minutes.</p>
        <label className="field">
          <span>Password</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" />
        </label>
        {twoFactor && (
          <label className="field">
            <span>6-digit code</span>
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        )}
        {err && <p className="error-text">{err}</p>}
        <div className="row gap">
          <button className="btn primary" disabled={!pw}>
            Confirm
          </button>
          <button type="button" className="btn ghost" onClick={() => onDone(false)}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------- Context page sections ----------

export function SafetySections({ actions }: { actions: AppActions }) {
  const [ov, setOv] = useState<Any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { run, modal } = useStepUp();
  const load = useCallback(async () => {
    try {
      setOv(await api<Any>("GET", "/api/system/overview"));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    // Deep links such as /?view=context#ai-usage scroll to their section once it exists.
    if (ov && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [ov]);

  const call = async (method: string, url: string, body?: unknown, okText?: string) => {
    try {
      const r = await run(() => api<Any>(method, url, body), ov?.security?.twoFactor);
      if (r?.security) setOv(r);
      else await load();
      if (okText) actions.toast({ text: okText });
      return r;
    } catch (e) {
      if ((e as ApiError).code !== "cancelled") actions.toast({ text: (e as Error).message, tone: "error" });
      return null;
    }
  };

  if (err) return <div className="card"><p className="error-text">{err}</p></div>;
  if (!ov) return <div className="card"><p className="muted small">Loading safety settings…</p></div>;

  return (
    <>
      {modal}
      <SafetyCard ov={ov} call={call} />
      <BudgetCard ov={ov} call={call} />
      <NotificationPrefsCard ov={ov} call={call} />
      <SecurityCard ov={ov} call={call} />
      <AgentsCard ov={ov} call={call} />
      <ConnectionsCard ov={ov} />
      <ActivityCard />
    </>
  );
}

type Call = (method: string, url: string, body?: unknown, okText?: string) => Promise<Any>;

function SafetyCard({ ov, call }: { ov: Any; call: Call }) {
  const c = ov.controls;
  const anyPaused = c.agentsPaused || c.actionsPaused || c.aiPaused;
  return (
    <section className="card" id="safety">
      <h2 className="h3">Safety switch</h2>
      <p className="small muted">Stops every agent and every approved action at once. Planning and chat keep working. Nothing runs again until you resume it.</p>
      <ul className="plain-list small">
        <li>Agents: {c.agentsPaused ? <strong className="warn-text">paused</strong> : "running"}</li>
        <li>Approved actions: {c.actionsPaused ? <strong className="warn-text">paused</strong> : "running"}</li>
        <li>AI for agents: {c.aiPaused ? <strong className="warn-text">paused{c.aiPausedReason ? ` (${c.aiPausedReason})` : ""}</strong> : "on"}</li>
      </ul>
      <div className="row gap" style={{ flexWrap: "wrap", marginTop: 10 }}>
        {!(c.agentsPaused && c.actionsPaused) && (
          <button className="btn danger" onClick={() => call("POST", "/api/system/stop-all", {}, "Everything is paused.")}>
            Stop all agents and actions
          </button>
        )}
        {c.agentsPaused && <button className="btn small" onClick={() => call("POST", "/api/system/controls", { control: "agents", paused: false }, "Agents resumed.")}>Resume agents</button>}
        {c.actionsPaused && <button className="btn small" onClick={() => call("POST", "/api/system/controls", { control: "actions", paused: false }, "Actions resumed.")}>Resume actions</button>}
        {c.aiPaused && <button className="btn small" onClick={() => call("POST", "/api/system/controls", { control: "ai", paused: false }, "AI resumed.")}>Resume AI (after adding credit)</button>}
      </div>
      {!anyPaused && <p className="small muted" style={{ marginTop: 8 }}>No agents are switched on yet, so nothing runs on its own.</p>}
    </section>
  );
}

function BudgetCard({ ov, call }: { ov: Any; call: Call }) {
  const s = ov.budget.spend;
  const b = ov.budget.settings;
  const [monthly, setMonthly] = useState(String(b.monthlyUsd));
  const [daily, setDaily] = useState(String(b.dailyUsd));
  const [block, setBlock] = useState<boolean>(b.blockPlannerAtLimit);
  const pct = Math.min(100, s.percent);
  return (
    <section className="card" id="ai-usage">
      <h2 className="h3">AI usage and budget</h2>
      <p className="small">
        <strong>{money(s.monthUsd)}</strong> of {money(s.monthlyUsd)} this month ({s.percent}%) · today {money(s.dayUsd)}
      </p>
      <div className="cap-bar" style={{ height: 8, borderRadius: 999, background: "var(--surface-3)", overflow: "hidden", margin: "8px 0" }} aria-hidden>
        <div style={{ width: `${pct}%`, height: "100%", background: s.state === "limit" ? "var(--danger)" : s.state === "warning" ? "var(--warn)" : "var(--accent)" }} />
      </div>
      {s.byWorkflow.length > 0 && (
        <ul className="plain-list small muted">
          {s.byWorkflow.map((w: Any) => (
            <li key={w.workflow}>
              {w.workflow === "planner" ? "Planning chat" : w.workflow === "task_helper" ? "Task helpers" : w.workflow.replace("agent:", "Agent ")}: {money(w.usd)} ({w.calls} call{w.calls === 1 ? "" : "s"})
            </li>
          ))}
        </ul>
      )}
      <p className="small muted">
        Measured by Nikki from Claude’s own token counts. Your Anthropic invoice is the final word. Nikki never buys credit or turns on auto top-up. You’ll get an alert at 50%, 75%, 90% and 100%. At 100%, agents stop; planning keeps working unless you block it below.
      </p>
      <form
        className="row gap"
        style={{ flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          call("PUT", "/api/system/budget", { monthlyUsd: Number(monthly), dailyUsd: Number(daily), blockPlannerAtLimit: block, perAgentMonthlyUsd: b.perAgentMonthlyUsd }, "Budget saved.");
        }}
      >
        <label className="field" style={{ width: 130 }}>
          <span>Monthly ($)</span>
          <input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        </label>
        <label className="field" style={{ width: 150 }}>
          <span>Daily, agents ($)</span>
          <input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
        </label>
        <label className="check-line small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} /> Block planning too at 100%
        </label>
        <button className="btn small">Save</button>
      </form>
    </section>
  );
}

function NotificationPrefsCard({ ov, call }: { ov: Any; call: Call }) {
  const p = ov.notifications.prefs;
  const save = (patch: Any) => call("PUT", "/api/system/notifications/prefs", { ...p, ...patch }, "Saved.");
  return (
    <section className="card" id="notification-settings">
      <h2 className="h3">What can notify you</h2>
      <p className="small muted">Everything is kept in Nikki’s inbox (the bell at the top). These switches choose what also reaches your lock screen.</p>
      <div className="chips" style={{ margin: "8px 0" }}>
        {ov.notifications.categories.map((c: Any) => (
          <button key={c.id} className={`chip ${p.push[c.id] ? "" : "muted"}`} aria-pressed={!!p.push[c.id]} onClick={() => save({ push: { ...p.push, [c.id]: !p.push[c.id] } })}>
            {p.push[c.id] ? "✓ " : ""}
            {c.label}
          </button>
        ))}
      </div>
      <label className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" checked={p.quietHours.enabled} onChange={(e) => save({ quietHours: { ...p.quietHours, enabled: e.target.checked } })} />
        Quiet hours {p.quietHours.start}–{p.quietHours.end} (India time). Only urgent items and reminders you set come through; the rest arrive as one summary afterwards.
      </label>
      <label className="small" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
        <input type="checkbox" checked={p.showSensitivePreviews} onChange={(e) => save({ showSensitivePreviews: e.target.checked })} />
        Show private details on the lock screen (off: it just says “Nikki” and asks you to open the app)
      </label>
      <div className="row gap" style={{ marginTop: 10 }}>
        <button className="btn small" onClick={() => call("POST", "/api/system/notifications/test", {}, "Test sent. Check your lock screen.")}>
          Send a test through the inbox
        </button>
      </div>
    </section>
  );
}

function SecurityCard({ ov, call }: { ov: Any; call: Call }) {
  const s = ov.security;
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  return (
    <section className="card" id="security">
      <h2 className="h3">Security and devices</h2>
      <ul className="plain-list small">
        <li>Password: {s.passwordSet ? "on" : <span className="warn-text">not set (only safe on your own computer)</span>}</li>
        <li>
          Encryption key: {s.vault.ready ? <>set (fingerprint {s.vault.keyId}){s.vault.rotating ? ", rotating" : ""}</> : <span className="warn-text">not set yet. Tokens for future connections and backups need it.</span>}
          {s.vault.problem && <span className="danger-text"> {s.vault.problem}</span>}
        </li>
        <li>
          Stored secrets: {s.secrets.total ? `${s.secrets.sealed} of ${s.secrets.total} encrypted` : "none yet"}
        </li>
        <li>
          Two-step sign-in: {s.twoFactor ? `on (${s.recoveryCodesLeft} recovery codes left)` : "off"}
          {s.twoFactorForcedOff && <span className="warn-text"> (switched off by the server’s recovery setting)</span>}
        </li>
      </ul>

      {s.passwordSet && !s.twoFactor && !setup && (
        <button className="btn small" style={{ marginTop: 8 }} disabled={!s.vault.ready} onClick={async () => setSetup(await call("POST", "/api/system/2fa/setup", {}))}>
          Turn on two-step sign-in
        </button>
      )}
      {setup && (
        <div className="card" style={{ marginTop: 10 }}>
          <p className="small">
            1. On your iPhone, tap <a className="link" href={setup.uri}>Add to Passwords</a> (or add this key by hand in any authenticator app): <code style={{ wordBreak: "break-all" }}>{setup.secret}</code>
          </p>
          <p className="small">2. Type the 6-digit code it shows:</p>
          <div className="row gap">
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 120 }} aria-label="6-digit code" />
            <button
              className="btn small primary"
              onClick={async () => {
                const r = await call("POST", "/api/system/2fa/enable", { code });
                if (r?.recoveryCodes) {
                  setCodes(r.recoveryCodes);
                  setSetup(null);
                }
              }}
            >
              Turn on
            </button>
          </div>
        </div>
      )}
      {codes && (
        <div className="card" style={{ marginTop: 10 }}>
          <p className="small"><strong>Save these recovery codes</strong> somewhere safe (for example a note in Apple Passwords). Each works once if you lose your phone. They won’t be shown again.</p>
          <p className="small" style={{ fontFamily: "monospace" }}>{codes.join("  ")}</p>
          <button className="btn small" onClick={() => setCodes(null)}>I’ve saved them</button>
        </div>
      )}
      {s.twoFactor && (
        <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => { const c = prompt("Enter a current 6-digit code (or a recovery code) to turn two-step sign-in off:"); if (c) call("POST", "/api/system/2fa/disable", { code: c }, "Two-step sign-in is off."); }}>
          Turn two-step sign-in off
        </button>
      )}

      <h3 className="h3" style={{ marginTop: 16 }}>Signed-in devices</h3>
      {!s.passwordSet ? (
        <p className="small muted">Devices appear here once a password is set.</p>
      ) : (
        <ul className="plain-list">
          {s.sessions.map((d: Any) => (
            <li key={d.id} className="row gap center-y" style={{ justifyContent: "space-between", padding: "6px 0" }}>
              <span className="small">
                <strong>{d.label}</strong>
                {d.current && <span className="pill" style={{ marginLeft: 6 }}>this device</span>}
                <br />
                <span className="muted">Last used {when(d.lastSeenAt)} · signed in {when(d.createdAt)}</span>
              </span>
              {!d.current && (
                <button className="btn small ghost" onClick={() => call("POST", `/api/system/sessions/${d.id}/revoke`, {}, "Signed out.")}>
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {s.sessions.length > 1 && (
        <button className="btn small danger" onClick={() => call("POST", "/api/system/sessions/revoke-others", {}, "Every other device is signed out.")}>
          Sign out everywhere else
        </button>
      )}

      <h3 className="h3" style={{ marginTop: 16 }}>Backups</h3>
      {ov.backups.length ? (
        <ul className="plain-list small">
          {ov.backups.map((b: Any) => (
            <li key={b.file}>
              {b.file} · {(b.bytes / 1024).toFixed(0)} KB ·{" "}
              <a className="link" href={`/api/system/backups/${encodeURIComponent(b.file)}`} onClick={async (e) => {
                // Needs a fresh password check on this device first; then the browser downloads the file.
                e.preventDefault();
                const r = await call("POST", `/api/system/backups/${encodeURIComponent(b.file)}/prepare`, {});
                if (r) location.href = `/api/system/backups/${encodeURIComponent(b.file)}`;
              }}>download (encrypted)</a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">{s.vault.ready ? "The first nightly backup is made at 02:30 India time." : "Nightly encrypted backups start once the encryption key is set."}</p>
      )}
      {s.vault.ready && <button className="btn small ghost" onClick={() => call("POST", "/api/system/backups/run", {}, "Backup made.")}>Back up now</button>}
    </section>
  );
}

function AgentsCard({ ov, call }: { ov: Any; call: Call }) {
  return (
    <section className="card" id="agents">
      <h2 className="h3">Agents</h2>
      <p className="small muted">Helpers that run on a schedule. They are off until you turn them on, can only use the tools listed, and anything that changes something waits for your approval in the inbox.</p>
      <ul className="plain-list">
        {ov.agents.map((a: Any) => (
          <li key={a.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
            <div className="row gap center-y" style={{ justifyContent: "space-between" }}>
              <strong className="small">{a.name}</strong>
              <span className="row gap">
                <button className="btn small ghost" onClick={() => call("POST", `/api/system/agents/${a.id}/run`, {}, "Ran once.")}>Run once</button>
                <button className={`btn small ${a.enabled ? "" : "primary"}`} onClick={() => call("POST", `/api/system/agents/${a.id}/enable`, { enabled: !a.enabled }, a.enabled ? "Turned off." : "Turned on.")}>
                  {a.enabled ? "Turn off" : "Turn on"}
                </button>
              </span>
            </div>
            <p className="small muted">{a.description}</p>
            <p className="small muted">
              Space: {a.config.spaceId} · AI: {a.config.useAi ? `yes (${a.config.modelTier})` : "no, code only"} · Highest permission: {a.config.maxLevel}
              {a.config.schedule?.type === "daily" ? ` · daily ${a.config.schedule.time}` : ""}
              {a.lastRun ? ` · last run ${when(a.lastRun.startedAt)} (${a.lastRun.status})` : ""}
            </p>
          </li>
        ))}
      </ul>
      <h3 className="h3" style={{ marginTop: 12 }}>Spaces</h3>
      <ul className="plain-list small">
        {ov.spaces.map((s: Any) => (
          <li key={s.id}>
            <strong>{s.name}</strong> · {s.enabled ? "on" : "off"}
            {s.confidential ? " · confidential, never sent to AI" : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConnectionsCard({ ov }: { ov: Any }) {
  return (
    <section className="card" id="connections">
      <h2 className="h3">Connected accounts</h2>
      {ov.accounts.length ? (
        <ul className="plain-list small">{ov.accounts.map((a: Any) => <li key={a.id}>{a.label} · {a.status}</li>)}</ul>
      ) : (
        <p className="small muted">None yet. Gmail, Google Calendar, Drive and the rest come in Phase 1, after your approval. Nothing is connected today.</p>
      )}
    </section>
  );
}

function ActivityCard() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Any[]>([]);
  useEffect(() => {
    if (open) api<Any>("GET", "/api/system/activity").then((r) => setRows(r.entries)).catch(() => {});
  }, [open]);
  return (
    <section className="card" id="activity">
      <h2 className="h3">Activity log</h2>
      <p className="small muted">A permanent record of sign-ins, approvals, agent runs and safety changes. It stores what happened, never the content of your messages.</p>
      {!open ? (
        <button className="btn small ghost" onClick={() => setOpen(true)}>Show recent activity</button>
      ) : (
        <ul className="plain-list small" style={{ maxHeight: 320, overflowY: "auto" }}>
          {rows.map((r) => (
            <li key={r.seq} className="muted">
              {when(r.at)} · {r.actor} · {r.kind}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- bell + inbox ----------

export function Bell({ onOpen, tick }: { onOpen: () => void; tick: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const get = () =>
      api<{ unread: number; pending: number }>("GET", "/api/system/badge")
        .then((r) => {
          if (!live) return;
          const total = r.unread + r.pending;
          setN(total);
          // The home-screen icon badge (iPhone 16.4+ when installed).
          (navigator as Any).setAppBadge?.(total).catch?.(() => {});
          if (!total) (navigator as Any).clearAppBadge?.().catch?.(() => {});
        })
        .catch(() => {});
    get();
    const id = window.setInterval(() => document.visibilityState === "visible" && get(), 60_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [tick]);
  return (
    <button className="icon-btn bell" onClick={onOpen} aria-label={n ? `Inbox, ${n} new` : "Inbox"} title="Inbox">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {n > 0 && <span className="bell-count">{n > 99 ? "99+" : n}</span>}
    </button>
  );
}

export function Inbox({ actions, onChange }: { actions: AppActions; onChange: () => void }) {
  const [data, setData] = useState<{ items: Any[]; unread: number } | null>(null);
  const [acts, setActs] = useState<Any[]>([]);
  const [cat, setCat] = useState<string>("");
  const { run, modal } = useStepUp();
  const focus = new URLSearchParams(location.search).get("action");
  const load = useCallback(async () => {
    const [n, a] = await Promise.all([api<Any>("GET", `/api/system/notifications${cat ? `?category=${cat}` : ""}`), api<Any>("GET", "/api/system/actions")]);
    setData(n);
    setActs(a.actions);
  }, [cat]);
  useEffect(() => {
    load().catch((e) => actions.toast({ text: (e as Error).message, tone: "error" }));
  }, [load]);

  const act = async (url: string, body?: unknown, ok?: string) => {
    try {
      await run(() => api<Any>("POST", url, body ?? {}));
      if (ok) actions.toast({ text: ok });
    } catch (e) {
      if ((e as ApiError).code !== "cancelled") actions.toast({ text: (e as Error).message, tone: "error" });
    }
    await load();
    onChange();
  };

  const waiting = acts.filter((a) => a.status === "pending" || a.status === "uncertain" || a.status === "scheduled");
  return (
    <div className="page">
      {modal}
      <div className="page-head">
        <h1 className="h2">Inbox</h1>
        <p className="muted small">Approvals and everything Nikki has told you. Nothing outside Nikki happens without your approval here.</p>
      </div>

      <section className="card">
        <h2 className="h3">Waiting for you</h2>
        {!waiting.length && <p className="small muted">Nothing needs your approval.</p>}
        {waiting.map((a) => (
          <div key={a.id} className="card" style={{ marginTop: 10, borderColor: a.id === focus ? "var(--accent)" : undefined }}>
            <div className="row gap center-y" style={{ justifyContent: "space-between" }}>
              <strong className="small">{a.title}</strong>
              <span className="pill">{a.status === "uncertain" ? "check needed" : a.status === "scheduled" ? `scheduled ${when(a.executeAfter)}` : a.level === "consequential" ? "important: needs password" : "needs approval"}</span>
            </div>
            <ul className="plain-list small" style={{ margin: "6px 0" }}>
              {Object.entries(a.params).map(([k, v]) => (
                <li key={k}>
                  <span className="muted">{PARAM_LABEL[k] ?? k}:</span> {typeof v === "string" ? v : JSON.stringify(v)}
                </li>
              ))}
            </ul>
            <p className="small muted">Space: {cap(a.spaceId)}{a.agentId ? " · proposed by an agent" : ""} · expires {when(a.expiresAt)}</p>
            {a.status === "pending" && (
              <div className="row gap">
                <button className="btn small primary" onClick={() => act(`/api/system/actions/${a.id}/approve`, { paramsHash: a.paramsHash }, "Approved.")}>
                  Approve exactly this
                </button>
                <button className="btn small ghost" onClick={() => act(`/api/system/actions/${a.id}/reject`, {}, "Rejected.")}>
                  Reject
                </button>
              </div>
            )}
            {a.status === "scheduled" && (
              <button className="btn small ghost" onClick={() => act(`/api/system/actions/${a.id}/cancel`, {}, "Cancelled.")}>Cancel</button>
            )}
            {a.status === "uncertain" && (
              <>
                <p className="small warn-text">Nikki couldn’t confirm whether this happened, so it will not try again. Please check, then mark it.</p>
                <div className="row gap">
                  <button className="btn small" onClick={() => act(`/api/system/actions/${a.id}/resolve`, { outcome: "succeeded" })}>It happened</button>
                  <button className="btn small ghost" onClick={() => act(`/api/system/actions/${a.id}/resolve`, { outcome: "failed" })}>It didn’t happen</button>
                </div>
              </>
            )}
          </div>
        ))}
      </section>

      <section className="card">
        <div className="row gap center-y" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <h2 className="h3">Notifications</h2>
          <div className="row gap">
            <select className="small-select" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
              <option value="">All</option>
              <option value="reminder">Reminders</option>
              <option value="approval">Approvals</option>
              <option value="agent">Agent updates</option>
              <option value="budget">AI budget</option>
              <option value="security">Security</option>
              <option value="system">System</option>
            </select>
            {!!data?.unread && <button className="btn small ghost" onClick={() => act("/api/system/notifications/read", { ids: "all" })}>Mark all read</button>}
          </div>
        </div>
        {!data?.items.length && <p className="small muted">No notifications yet.</p>}
        <ul className="plain-list">
          {data?.items.map((n) => (
            <li key={n.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line)", opacity: n.readAt ? 0.65 : 1 }}>
              <div className="row gap center-y" style={{ justifyContent: "space-between" }}>
                <strong className="small">
                  {!n.readAt && <span className="dot" aria-label="unread" style={{ marginRight: 6 }} />}
                  {n.title}
                </strong>
                <span className="small muted">{when(n.createdAt)}</span>
              </div>
              {n.body && <p className="small">{n.body}</p>}
              <div className="row gap">
                {n.link && n.link !== "/?view=inbox" && (
                  <a className="link small" href={n.link} onClick={() => api("POST", "/api/system/notifications/read", { ids: [n.id] }).catch(() => {})}>
                    Open
                  </a>
                )}
                {!n.readAt && <button className="link small" onClick={() => act("/api/system/notifications/read", { ids: [n.id] })}>Mark read</button>}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
