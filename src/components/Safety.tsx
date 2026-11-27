import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { AppActions } from "../App";

/**
 * Phase 0 screens: the inbox (things to review, updates, history), the bell, and the Context page's Agent controls,
 * AI usage, Security and devices, Agents and Activity. They read /api/system/* and always show the personal
 * workspace's system state. Wording aims at a person using an assistant, not someone running AI infrastructure:
 * plain status first, details and settings behind "show more" rows.
 */

type Any = any; // the overview is a plain JSON snapshot; fields are read defensively below

// ---------- formatting (India time by default) ----------

const TZ = "Asia/Kolkata";
const money = (n: number) => `$${(n ?? 0).toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** "Saturday, 28 November · 9:00 AM" for a moment in time, shown in India time. */
export function fmtWhen(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${dayFmt.format(d).replace(/^(\w+) /, "$1, ")} · ${timeFmt.format(d)}`;
}

/** The same format for a wall-clock date and time that are already in India time (reminders). */
export function fmtLocal(date: string, time?: string) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time ?? "00:00").split(":").map(Number);
  const asUtc = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(asUtc).replace(/^(\w+) /, "$1, ");
  return time ? `${day} · ${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(asUtc)}` : day;
}

/** "Today · 9:12 AM", "Yesterday · 6:40 PM" or "Mon 23 Nov · 8:00 AM" for lists. */
function fmtRecent(iso: string) {
  const d = new Date(iso);
  const today = ymd(new Date());
  const yest = ymd(new Date(Date.now() - 86_400_000));
  const day = ymd(d) === today ? "Today" : ymd(d) === yest ? "Yesterday" : new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(d);
  return `${day} · ${timeFmt.format(d)}`;
}
const fmtDate = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));

/** Tomorrow at 9:00 in India time, as an ISO instant. */
function tomorrowMorning() {
  const [y, m, d] = ymd(new Date(Date.now() + 86_400_000)).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 9, 0) - 330 * 60_000).toISOString();
}

// ---------- shared bits ----------

/** A row that opens to show more. Used to keep settings and explanations out of the way until wanted. */
function More({ title, hint, children, id, open }: { title: string; hint?: ReactNode; children: ReactNode; id?: string; open?: boolean }) {
  return (
    <details className="disclosure" id={id} open={open}>
      <summary>
        <span>{title}</span>
        {hint && <span className="disclosure-hint">{hint}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

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
    // Deep links such as /?view=context#ai-usage open and scroll to their section once it exists.
    if (!ov || !location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (el instanceof HTMLDetailsElement) el.open = true;
    el?.scrollIntoView({ block: "start" });
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
  if (!ov) return <div className="card"><p className="muted small">Loading…</p></div>;

  return (
    <>
      {modal}
      <AgentControlsCard ov={ov} call={call} />
      <BudgetCard ov={ov} call={call} />
      <SecurityCard ov={ov} call={call} />
      <AgentsCard ov={ov} call={call} />
    </>
  );
}

type Call = (method: string, url: string, body?: unknown, okText?: string) => Promise<Any>;

function AgentControlsCard({ ov, call }: { ov: Any; call: Call }) {
  const c = ov.controls;
  const s = ov.agentStatus;
  const stopped = c.agentsPaused || c.actionsPaused;
  return (
    <section className="card" id="agent-controls">
      <span id="safety" />
      <div className="row gap center-y" style={{ justifyContent: "space-between" }}>
        <h2 className="h3" style={{ margin: 0 }}>Agent controls</h2>
        <span className={`tag ${stopped ? "warn" : "subtle"}`}>{stopped ? "Stopped" : "On"}</span>
      </div>
      <p className="small" style={{ marginTop: 8 }}>
        {stopped
          ? `Everything automatic is stopped${s.stoppedSince ? ` since ${fmtRecent(s.stoppedSince.at)}` : ""}. Planning, tasks, reminders and chat still work.`
          : s.enabled === 0
            ? "No agents are switched on, so nothing runs on its own. Planning and chat work as usual."
            : `${plural(s.enabled, "agent")} switched on. Anything they want to change waits for you in the inbox.`}
      </p>
      <dl className="status-grid small">
        <dt>Agents switched on</dt>
        <dd>{s.enabled} of {s.total}</dd>
        <dt>Running right now</dt>
        <dd>{s.runningNow}</dd>
        <dt>Waiting for your approval</dt>
        <dd>{s.waitingForYou}</dd>
        <dt>Scheduled to run later</dt>
        <dd>{s.scheduledActions}</dd>
        <dt>AI for agents</dt>
        <dd>{c.aiPaused ? <span className="warn-text">Paused{c.aiPausedReason ? `: ${c.aiPausedReason}` : ""}</span> : ov.budget.spend.state === "limit" ? <span className="warn-text">Paused: budget used up</span> : "Available"}</dd>
      </dl>
      <div className="row gap" style={{ flexWrap: "wrap", marginTop: 12 }}>
        {stopped ? (
          <button className="btn primary" onClick={() => call("POST", "/api/system/resume-all", {}, "Resumed. Anything approved before the stop will ask you again.")}>
            Resume
          </button>
        ) : (
          <button className="btn danger" onClick={() => call("POST", "/api/system/stop-all", {}, "Stopped. Nothing automatic will run until you resume.")}>
            Stop all agents and actions
          </button>
        )}
        {c.aiPaused && (
          <button className="btn small" onClick={() => call("POST", "/api/system/controls", { control: "ai", paused: false }, "AI resumed for agents.")}>
            Resume AI (after adding credit)
          </button>
        )}
      </div>
      <More title="What “Stop” does">
        <ul className="plain-list small muted bullets">
          <li>No agent starts, and a running agent stops before its next step.</li>
          <li>Nothing you approved runs, including scheduled items. Nothing new can be approved until you resume.</li>
          <li>A request already on its way to Claude can’t be recalled. It finishes, is counted, and nothing after it runs.</li>
          <li>Something already done outside Nikki (in future, an email that was sent) can’t be undone by this switch.</li>
          <li>The stop stays on if Nikki restarts.</li>
          <li>When you resume, anything approved that became due is not run by itself. Nikki asks you again.</li>
          <li>Planning, tasks, reminders, chat and your data are not affected.</li>
        </ul>
      </More>
    </section>
  );
}

const WORKFLOW_LABEL = (w: string) => (w === "planner" ? "Planning chat" : w === "task_helper" ? "Task helpers" : w.startsWith("agent:") ? "Agents" : w);

function BudgetCard({ ov, call }: { ov: Any; call: Call }) {
  const s = ov.budget.spend;
  const b = ov.budget.settings;
  const [monthly, setMonthly] = useState(String(b.monthlyUsd));
  const [daily, setDaily] = useState(String(b.dailyUsd));
  const [block, setBlock] = useState<boolean>(b.blockPlannerAtLimit);
  const pct = Math.min(100, s.percent);
  const status =
    s.state === "limit"
      ? `This month’s budget is used up. Background agents have stopped. ${s.plannerBlocked ? "Planning chat is paused until next month or until you raise the budget." : "Planning chat still works and is still counted."}`
      : s.state === "warning"
        ? `Over three quarters used. Background agents stop before they would pass ${money(s.monthlyUsd)}.`
        : "Within budget.";
  return (
    <section className="card" id="ai-usage">
      <h2 className="h3">AI usage</h2>
      <div className="stat-grid">
        <div>
          <span className="stat-label">Today</span>
          <strong className="stat-value">{money(s.dayUsd)}</strong>
        </div>
        <div>
          <span className="stat-label">This month</span>
          <strong className="stat-value">{money(s.monthUsd)}</strong>
        </div>
        <div>
          <span className="stat-label">Left this month</span>
          <strong className="stat-value">{money(s.remainingUsd)}</strong>
        </div>
      </div>
      <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Share of monthly AI budget used">
        <div className={`meter-fill ${s.state}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="small">
        {Math.round(s.percent)}% of your {money(s.monthlyUsd)} monthly budget. <span className={s.state === "ok" ? "muted" : "warn-text"}>{status}</span>
      </p>
      <p className="small muted">
        Measured by Nikki since {fmtDate(s.since)}. Your actual bill and remaining credit are in the Claude Console (Usage and Billing).
      </p>

      <More title="Where it went" hint={s.byWorkflow.length ? undefined : "nothing yet"}>
        {s.byWorkflow.length ? (
          <ul className="plain-list small">
            {s.byWorkflow.map((w: Any) => (
              <li key={w.workflow} className="row" style={{ justifyContent: "space-between" }}>
                <span>
                  {WORKFLOW_LABEL(w.workflow)} <span className="muted">· {plural(w.calls, "request")}</span>
                </span>
                <span>{money(w.usd)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No AI use recorded this month.</p>
        )}
        {s.unmeasuredCalls > 0 && <p className="small muted">{plural(s.unmeasuredCalls, "request")} failed before Claude reported its size and are shown as $0.</p>}
        <p className="small muted">Figures come from the token counts Claude returns with each answer, priced at Anthropic’s published rates. They are Nikki’s measurement, not the invoice, and may differ slightly.</p>
      </More>

      <More title="Manage budget" id="manage-budget">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            call("PUT", "/api/system/budget", { monthlyUsd: Number(monthly), dailyUsd: Number(daily), blockPlannerAtLimit: block, perAgentMonthlyUsd: b.perAgentMonthlyUsd }, "Budget saved.");
          }}
        >
          <div className="row gap" style={{ flexWrap: "wrap" }}>
            <label className="field" style={{ width: 150 }}>
              <span>Monthly budget ($)</span>
              <input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
            </label>
            <label className="field" style={{ width: 190 }}>
              <span>Daily limit, agents ($)</span>
              <input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
            </label>
          </div>
          <p className="small muted">
            The monthly budget covers all of Nikki’s AI use. Background agents always stop before they would go over it or over the daily limit. You’ll get a
            note at 50%, 75%, 90% and 100%, and a warning in the chat from 90%.
          </p>
          <fieldset className="radio-set small">
            <legend>When the monthly budget is used up, planning chat should</legend>
            <label>
              <input type="radio" name="planner" checked={!block} onChange={() => setBlock(false)} /> Keep working (still counted)
            </label>
            <label>
              <input type="radio" name="planner" checked={block} onChange={() => setBlock(true)} /> Pause until next month or until I raise the budget
            </label>
          </fieldset>
          <button className="btn small primary" style={{ marginTop: 8 }}>
            Save
          </button>
          <p className="small muted" style={{ marginTop: 8 }}>
            Nikki never buys credit or turns on auto top-up, and never raises these limits by itself. Tasks, reminders and your plan keep working even if AI
            credit runs out.
          </p>
        </form>
      </More>
    </section>
  );
}

/** Lock-screen choices; shown inside the existing "Reminders & notifications" card so there is one place for them. */
export function NotificationChoices({ toast }: { toast: AppActions["toast"] }) {
  const [p, setP] = useState<Any | null>(null);
  const [cats, setCats] = useState<Any[]>([]);
  useEffect(() => {
    api<Any>("GET", "/api/system/notifications/prefs")
      .then((r) => (setP(r.prefs), setCats(r.categories)))
      .catch(() => {});
  }, []);
  if (!p) return null;
  const save = async (patch: Any) => {
    const next = { ...p, ...patch };
    setP(next);
    try {
      await api("PUT", "/api/system/notifications/prefs", next);
    } catch (e) {
      toast({ text: (e as Error).message, tone: "error" });
    }
  };
  return (
    <More title="What reaches your lock screen" id="notification-settings">
      <p className="small muted">Everything is kept in the inbox (the bell). These choose what also appears on your phone.</p>
      <div className="chips" style={{ margin: "8px 0" }}>
        {cats.map((c: Any) => (
          <button key={c.id} className={`chip ${p.push[c.id] ? "on" : "muted"}`} aria-pressed={!!p.push[c.id]} onClick={() => save({ push: { ...p.push, [c.id]: !p.push[c.id] } })}>
            {p.push[c.id] ? "✓ " : ""}
            {c.label}
          </button>
        ))}
      </div>
      <label className="check-line small">
        <input type="checkbox" checked={p.quietHours.enabled} onChange={(e) => save({ quietHours: { ...p.quietHours, enabled: e.target.checked } })} />
        <span>
          Quiet hours, {p.quietHours.start} to {p.quietHours.end}. Reminders you set and urgent security alerts still come through; everything else waits and
          arrives as one summary in the morning.
        </span>
      </label>
      <label className="check-line small">
        <input type="checkbox" checked={p.showSensitivePreviews} onChange={(e) => save({ showSensitivePreviews: e.target.checked })} />
        <span>Show details on the lock screen. When off, private items just say “Nikki has something for you”.</span>
      </label>
    </More>
  );
}

function SecurityCard({ ov, call }: { ov: Any; call: Call }) {
  const s = ov.security;
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const others = s.sessions.filter((d: Any) => !d.current).length;
  return (
    <section className="card" id="security">
      <h2 className="h3">Security and devices</h2>
      <ul className="plain-list small check-list">
        <li className={s.passwordSet ? "" : "warn"}>{s.passwordSet ? "Password sign-in is on" : <span className="warn-text">No password set: only safe on your own computer</span>}</li>
        <li className={s.twoFactor ? "" : "info"}>{s.twoFactor ? `Two-step sign-in is on (${s.recoveryCodesLeft} recovery codes left)` : "Two-step sign-in is off (optional, recommended)"}</li>
        <li className={s.vault.ready ? "" : "warn"}>{s.vault.ready ? "Stored secrets and backups are encrypted" : <span className="warn-text">Encryption key not set yet: needed before any account can be connected</span>}</li>
        <li className="info">{plural(s.sessions.length, "device")} signed in</li>
      </ul>
      {s.vault.problem && <p className="small danger-text">{s.vault.problem}</p>}
      {s.twoFactorForcedOff && <p className="small warn-text">Two-step sign-in is switched off by the server’s recovery setting.</p>}

      {codes && (
        <div className="card inset">
          <p className="small">
            <strong>Save these recovery codes</strong> somewhere safe (for example a note in Apple Passwords). Each works once if you lose your phone. They won’t be
            shown again.
          </p>
          <p className="small" style={{ fontFamily: "monospace" }}>{codes.join("  ")}</p>
          <button className="btn small" onClick={() => setCodes(null)}>
            I’ve saved them
          </button>
        </div>
      )}

      <More title="Signed-in devices" hint={others ? `${others} other` : "only this one"}>
        {!s.passwordSet ? (
          <p className="small muted">Devices appear here once a password is set.</p>
        ) : (
          <ul className="plain-list">
            {s.sessions.map((d: Any) => (
              <li key={d.id} className="row gap center-y" style={{ justifyContent: "space-between", padding: "6px 0" }}>
                <span className="small">
                  <strong>{d.label}</strong>
                  {d.current && <span className="tag subtle" style={{ marginLeft: 6 }}>this device</span>}
                  <br />
                  <span className="muted">Last used {fmtRecent(d.lastSeenAt)}</span>
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
        {others > 0 && (
          <button className="btn small danger" onClick={() => call("POST", "/api/system/sessions/revoke-others", {}, "Every other device is signed out.")}>
            Sign out everywhere else
          </button>
        )}
      </More>

      <More title="Two-step sign-in" hint={s.twoFactor ? "on" : "off"}>
        {!s.twoFactor && !setup && (
          <>
            <p className="small muted">Adds a 6-digit code from your iPhone to every new sign-in. Recommended once the encryption key is set.</p>
            {s.passwordSet && (
              <button className="btn small" disabled={!s.vault.ready} onClick={async () => setSetup(await call("POST", "/api/system/2fa/setup", {}))}>
                Turn on two-step sign-in
              </button>
            )}
          </>
        )}
        {setup && (
          <div>
            <p className="small">
              1. On your iPhone, tap <a className="link" href={setup.uri}>Add to Passwords</a> (or add this key in any authenticator app):{" "}
              <code style={{ wordBreak: "break-all" }}>{setup.secret}</code>
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
        {s.twoFactor && (
          <button
            className="btn small ghost"
            onClick={() => {
              const c = prompt("Enter a current 6-digit code (or a recovery code) to turn two-step sign-in off:");
              if (c) call("POST", "/api/system/2fa/disable", { code: c }, "Two-step sign-in is off.");
            }}
          >
            Turn two-step sign-in off
          </button>
        )}
      </More>

      <More title="Backups" hint={ov.backups.length ? `last ${fmtRecent(ov.backups[0].createdAt ?? ov.backups[0].at ?? new Date().toISOString())}` : s.vault.ready ? "nightly" : "need the key"}>
        <p className="small muted">
          {s.vault.ready
            ? "An encrypted copy of your data is made every night at 2:30 AM and kept for 14 days. Downloading one asks for your password."
            : "Nightly encrypted backups start once the encryption key is set on the server."}
        </p>
        {ov.backups.length > 0 && (
          <ul className="plain-list small">
            {ov.backups.map((b: Any) => (
              <li key={b.file}>
                {b.file} · {(b.bytes / 1024).toFixed(0)} KB ·{" "}
                <a
                  className="link"
                  href={`/api/system/backups/${encodeURIComponent(b.file)}`}
                  onClick={async (e) => {
                    // Needs a fresh password check on this device first; then the browser downloads the file.
                    e.preventDefault();
                    const r = await call("POST", `/api/system/backups/${encodeURIComponent(b.file)}/prepare`, {});
                    if (r) location.href = `/api/system/backups/${encodeURIComponent(b.file)}`;
                  }}
                >
                  download (encrypted)
                </a>
              </li>
            ))}
          </ul>
        )}
        {s.vault.ready && (
          <button className="btn small ghost" onClick={() => call("POST", "/api/system/backups/run", {}, "Backup made.")}>
            Back up now
          </button>
        )}
      </More>

      <More title="Activity log">
        <ActivityList />
      </More>
    </section>
  );
}

function AgentsCard({ ov, call }: { ov: Any; call: Call }) {
  return (
    <section className="card" id="agents">
      <h2 className="h3">Agents</h2>
      <p className="small muted">
        Helpers that check things for you on a schedule. They start switched off, can only use what you allow, and anything they want to change waits for you
        in the inbox.
      </p>
      <ul className="plain-list">
        {ov.agents.map((a: Any) => (
          <li key={a.id} className="agent-row">
            <div className="row gap center-y" style={{ justifyContent: "space-between" }}>
              <span>
                <strong className="small">{a.name}</strong> <span className={`tag ${a.enabled ? "" : "subtle"}`}>{a.enabled ? "On" : "Off"}</span>
              </span>
              <span className="row gap">
                <button className="btn small ghost" onClick={() => call("POST", `/api/system/agents/${a.id}/run`, {}, "Ran once.")}>
                  Run once
                </button>
                <button className={`btn small ${a.enabled ? "" : "primary"}`} onClick={() => call("POST", `/api/system/agents/${a.id}/enable`, { enabled: !a.enabled }, a.enabled ? "Switched off." : "Switched on.")}>
                  {a.enabled ? "Switch off" : "Switch on"}
                </button>
              </span>
            </div>
            <p className="small muted">{a.description}</p>
            <p className="small muted">
              {a.config.useAi ? "Uses AI" : "No AI (free)"}
              {a.config.schedule?.type === "daily" ? ` · every day at ${a.config.schedule.time}` : ""}
              {a.lastRun ? ` · last ran ${fmtRecent(a.lastRun.startedAt)}` : " · hasn’t run yet"}
            </p>
          </li>
        ))}
      </ul>
      <More title="Spaces" hint={`${ov.spaces.filter((s: Any) => s.enabled).length} on`}>
        <p className="small muted">Each account and agent belongs to one space, and spaces never share data.</p>
        <ul className="plain-list small">
          {ov.spaces.map((s: Any) => (
            <li key={s.id}>
              <strong>{s.name}</strong> · {s.enabled ? "on" : "off"}
              {s.confidential ? " · confidential, never sent to AI" : ""}
            </li>
          ))}
        </ul>
      </More>
      <p className="small muted" style={{ marginTop: 10 }}>
        Connected accounts: {ov.accounts.length ? ov.accounts.map((a: Any) => `${a.label} (${a.status})`).join(", ") : "none. Gmail, Calendar and Drive come later, only after your approval."}
      </p>
    </section>
  );
}

const ACTIVITY_LABEL: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.login_failed": "Wrong sign-in attempt",
  "action.proposed": "Suggestion created",
  "action.approved": "Approved",
  "action.rejected": "Dismissed",
  "action.edited": "Edited",
  "action.snoozed": "Put off",
  "action.succeeded": "Done",
  "action.failed": "Didn’t work",
  "action.uncertain": "Needs a check",
  "control.paused": "Stopped",
  "control.resumed": "Resumed",
  "budget.changed": "Budget changed",
  "budget.threshold": "Budget alert",
  "agent.run_started": "Agent started",
  "agent.run_finished": "Agent finished",
};

function ActivityList() {
  const [rows, setRows] = useState<Any[] | null>(null);
  useEffect(() => {
    api<Any>("GET", "/api/system/activity")
      .then((r) => setRows(r.entries))
      .catch(() => setRows([]));
  }, []);
  if (!rows) return <p className="small muted">Loading…</p>;
  return (
    <>
      <p className="small muted">A permanent record of sign-ins, approvals, agent runs and safety changes. It never stores the content of your messages.</p>
      <ul className="plain-list small" style={{ maxHeight: 300, overflowY: "auto" }}>
        {rows.map((r) => (
          <li key={r.seq} className="muted">
            {fmtRecent(r.at)} · {ACTIVITY_LABEL[r.kind] ?? r.kind}
            {r.actor?.startsWith("agent:") ? " (agent)" : r.actor === "system" ? " (Nikki)" : ""}
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------- budget notice in chat ----------

/** Shown above the chat from 90% of the monthly budget, so a planning conversation never passes the limit unannounced. */
export function BudgetNotice({ tick }: { tick: number }) {
  const [b, setB] = useState<Any | null>(null);
  useEffect(() => {
    api<Any>("GET", "/api/system/badge")
      .then((r) => setB(r.budget ?? null))
      .catch(() => {});
  }, [tick]);
  if (!b || b.percent < 90) return null;
  return (
    <div className={`budget-notice ${b.plannerBlocked ? "blocked" : ""}`} role="status">
      {b.plannerBlocked
        ? `This month’s AI budget (${money(b.monthlyUsd)}) is used up, so planning chat is paused. Tasks and reminders still work.`
        : b.percent >= 100
          ? `This month’s AI budget (${money(b.monthlyUsd)}) is used up. Chat still works and is still counted.`
          : `${Math.round(b.percent)}% of this month’s ${money(b.monthlyUsd)} AI budget is used.`}{" "}
      <a className="link" href="/?view=context#manage-budget">
        Manage budget
      </a>
    </div>
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

type Tab = "review" | "updates" | "history";
const CAT_FILTERS: [string, string][] = [
  ["", "All"],
  ["reminder", "Reminders"],
  ["approval", "Approvals"],
  ["agent", "Agents"],
  ["budget", "AI budget"],
  ["security", "Security"],
  ["system", "System"],
];
const DONE: Record<string, string> = { succeeded: "Done", rejected: "Dismissed", expired: "Expired, not done", cancelled: "Cancelled", failed: "Didn’t work" };

export function Inbox({ actions, onChange }: { actions: AppActions; onChange: () => void }) {
  const params = new URLSearchParams(location.search);
  const focus = params.get("action");
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) || "review");
  const [data, setData] = useState<{ items: Any[]; unread: number } | null>(null);
  const [acts, setActs] = useState<Any[]>([]);
  const [cat, setCat] = useState<string>("");
  const [showLater, setShowLater] = useState(false);
  const { run, modal } = useStepUp();
  const load = useCallback(async () => {
    const [n, a] = await Promise.all([api<Any>("GET", `/api/system/notifications${cat ? `?category=${cat}` : ""}`), api<Any>("GET", "/api/system/actions")]);
    setData(n);
    setActs(a.actions);
  }, [cat]);
  useEffect(() => {
    load().catch((e) => actions.toast({ text: (e as Error).message, tone: "error" }));
  }, [load]);

  const act = async (method: string, url: string, body?: unknown, ok?: string) => {
    try {
      const r = await run(() => api<Any>(method, url, body ?? {}));
      if (ok) actions.toast({ text: ok });
      return r;
    } catch (e) {
      if ((e as ApiError).code !== "cancelled") actions.toast({ text: (e as Error).message, tone: "error" });
      return null;
    } finally {
      await load();
      onChange();
    }
  };

  const now = Date.now();
  const snoozed = (a: Any) => a.status === "pending" && a.snoozedUntil && new Date(a.snoozedUntil).getTime() > now;
  const waiting = acts.filter((a) => (a.status === "pending" && !snoozed(a)) || a.status === "uncertain");
  const later = acts.filter(snoozed);
  const scheduled = acts.filter((a) => a.status === "scheduled" || a.status === "approved");
  const history = acts.filter((a) => DONE[a.status]);

  return (
    <div className="page inbox">
      {modal}
      <div className="page-head">
        <h1 className="h2">Inbox</h1>
      </div>
      <div className="tabs inbox-tabs" role="tablist" aria-label="Inbox sections">
        {(
          [
            ["review", "To review", waiting.length],
            ["updates", "Updates", data?.unread ?? 0],
            ["history", "History", 0],
          ] as [Tab, string, number][]
        ).map(([id, label, count]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
            {label}
            {count > 0 && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </div>

      {tab === "review" && (
        <section aria-label="To review">
          {!waiting.length && (
            <div className="card empty-note">
              <p className="small muted">Nothing to review. When Nikki suggests something, it appears here for you to accept or dismiss.</p>
            </div>
          )}
          {waiting.map((a) => (
            <ApprovalCard key={a.id} a={a} focused={a.id === focus} act={act} />
          ))}
          {later.length > 0 && (
            <div className="later-row small muted">
              {plural(later.length, "item")} put off until later.{" "}
              <button className="link small" onClick={() => setShowLater(!showLater)}>
                {showLater ? "Hide" : "Show"}
              </button>
            </div>
          )}
          {showLater && later.map((a) => <ApprovalCard key={a.id} a={a} focused={false} act={act} />)}
          {scheduled.length > 0 && (
            <div className="card">
              <h2 className="h3">Approved, waiting for their time</h2>
              <ul className="plain-list small">
                {scheduled.map((a) => (
                  <li key={a.id} className="row gap center-y" style={{ justifyContent: "space-between", padding: "4px 0" }}>
                    <span>
                      {a.noun}: {a.params.title ?? a.title}
                      {a.executeAfter ? <span className="muted"> · {fmtWhen(a.executeAfter)}</span> : null}
                    </span>
                    <button className="btn small ghost" onClick={() => act("POST", `/api/system/actions/${a.id}/cancel`, {}, "Cancelled.")}>
                      Cancel
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="small muted inbox-foot">
            Requests you make yourself in chat are confirmed there and don’t come here again. This list is for Nikki’s own suggestions and for anything that
            would leave Nikki.
          </p>
        </section>
      )}

      {tab === "updates" && (
        <section aria-label="Updates">
          <div className="chips scroll-x" role="group" aria-label="Show">
            {CAT_FILTERS.map(([id, label]) => (
              <button key={id || "all"} className={`chip ${cat === id ? "on" : ""}`} aria-pressed={cat === id} onClick={() => setCat(id)}>
                {label}
              </button>
            ))}
          </div>
          {!data?.items.length && (
            <div className="card empty-note">
              <p className="small muted">No updates{cat ? " here" : " yet"}.</p>
            </div>
          )}
          {!!data?.items.length && (
            <div className="card list-card">
              {!!data.unread && (
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <button className="link small" onClick={() => act("POST", "/api/system/notifications/read", { ids: "all" })}>
                    Mark all as read
                  </button>
                </div>
              )}
              <ul className="plain-list">
                {group(data.items).map(({ n, count }) => (
                  <li key={n.id} className={`update-row ${n.readAt ? "read" : ""}`}>
                    <a
                      className="update-link"
                      href={n.link && n.link !== "/?view=inbox" ? n.link : undefined}
                      onClick={() => !n.readAt && api("POST", "/api/system/notifications/read", { ids: [n.id] }).catch(() => {})}
                    >
                      <span className="update-head">
                        {!n.readAt && <span className="dot" aria-label="unread" />}
                        <strong className="small">{n.title}</strong>
                        {count > 1 && <span className="tag subtle">×{count}</span>}
                        <span className="small muted update-time">{fmtRecent(n.createdAt)}</span>
                      </span>
                      {n.body && <span className="small muted update-body">{n.body}</span>}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {tab === "history" && (
        <section aria-label="History">
          {!history.length ? (
            <div className="card empty-note">
              <p className="small muted">Nothing yet. Accepted, dismissed and expired suggestions are listed here.</p>
            </div>
          ) : (
            <div className="card list-card">
              <ul className="plain-list">
                {history.map((a) => (
                  <li key={a.id} className="update-row read">
                    <span className="update-head">
                      <strong className="small">
                        {a.noun}: {a.params.title ?? a.title}
                      </strong>
                      <span className={`tag ${a.status === "succeeded" ? "" : "subtle"}`}>{DONE[a.status]}</span>
                    </span>
                    <span className="small muted update-body">
                      {fmtRecent(a.updatedAt)}
                      {a.agentName ? ` · suggested by ${a.agentName}` : ""}
                      {a.status === "failed" && a.error ? ` · ${a.error}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** Folds identical notifications in a row ("New sign-in" ×3) into one line. */
function group(items: Any[]) {
  const out: { n: Any; count: number }[] = [];
  for (const n of items) {
    const last = out[out.length - 1];
    if (last && last.n.title === n.title && last.n.body === n.body && !!last.n.readAt === !!n.readAt) last.count++;
    else out.push({ n, count: 1 });
  }
  return out;
}

type Act = (method: string, url: string, body?: unknown, ok?: string) => Promise<Any>;

/** One suggestion: what, when, why, from whom, what approving really does, and the actions that fit it. */
function ApprovalCard({ a, focused, act }: { a: Any; focused: boolean; act: Act }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [laterOpen, setLaterOpen] = useState(false);
  const p = a.params ?? {};
  const important = a.level === "consequential";
  const startEdit = () => {
    setForm(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v ?? "")])));
    setEditing(true);
  };
  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    const params: Record<string, unknown> = { ...p };
    for (const [k, v] of Object.entries(form)) params[k] = typeof p[k] === "number" ? Number(v) : v;
    const r = await act("PATCH", `/api/system/actions/${a.id}`, { params }, "Changed. Check it, then confirm.");
    if (r) setEditing(false);
  };

  if (a.status === "uncertain") {
    return (
      <article className={`card approval-card ${focused ? "focused" : ""}`}>
        <div className="approval-eyebrow warn-text">Needs a check</div>
        <h2 className="approval-title">{p.title ?? a.title}</h2>
        <p className="small">Nikki couldn’t confirm whether this happened, so it won’t try again by itself. Please check, then tell Nikki.</p>
        <div className="approval-actions">
          <button className="btn small primary" onClick={() => act("POST", `/api/system/actions/${a.id}/resolve`, { outcome: "succeeded" }, "Thanks, noted.")}>
            It happened
          </button>
          <button className="btn small ghost" onClick={() => act("POST", `/api/system/actions/${a.id}/resolve`, { outcome: "failed" }, "Noted as not done.")}>
            It didn’t happen
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className={`card approval-card ${focused ? "focused" : ""}`}>
      <div className="approval-eyebrow">
        <span>
          {a.noun} · suggested by {a.agentName ?? "Nikki"}
        </span>
        {important && <span className="tag warn">Asks for your password</span>}
      </div>
      {!editing ? (
        <>
          <h2 className="approval-title">{p.title ?? a.title}</h2>
          {(p.date || p.estimateMinutes || p.body) && (
            <p className="approval-when">
              {p.date ? fmtLocal(p.date, p.time) : p.estimateMinutes ? `About ${p.estimateMinutes} minutes` : p.body}
            </p>
          )}
          {a.reason && (
            <p className="small">
              <span className="muted">Why: </span>
              {a.reason}
            </p>
          )}
          {a.consequence && <p className="small muted">{a.consequence}</p>}
          {a.snoozedUntil && new Date(a.snoozedUntil).getTime() > Date.now() && <p className="small muted">Put off until {fmtWhen(a.snoozedUntil)}.</p>}
          <div className="approval-actions">
            <button className="btn small primary" onClick={() => act("POST", `/api/system/actions/${a.id}/approve`, { paramsHash: a.paramsHash }, `${a.approveLabel}: done.`)}>
              {a.approveLabel}
            </button>
            <button className="btn small ghost" onClick={startEdit}>
              Edit
            </button>
            <span className="later-wrap">
              <button className="btn small ghost" aria-expanded={laterOpen} onClick={() => setLaterOpen(!laterOpen)}>
                Later
              </button>
              {laterOpen && (
                <span className="later-menu" role="menu">
                  <button role="menuitem" className="btn small ghost" onClick={() => (setLaterOpen(false), act("POST", `/api/system/actions/${a.id}/snooze`, { until: new Date(Date.now() + 3 * 3600_000).toISOString() }, "Put off for 3 hours."))}>
                    In 3 hours
                  </button>
                  <button role="menuitem" className="btn small ghost" onClick={() => (setLaterOpen(false), act("POST", `/api/system/actions/${a.id}/snooze`, { until: tomorrowMorning() }, "Put off until tomorrow morning."))}>
                    Tomorrow morning
                  </button>
                </span>
              )}
            </span>
            <button className="btn small ghost subtle-danger" onClick={() => act("POST", `/api/system/actions/${a.id}/reject`, {}, "Dismissed.")}>
              Dismiss
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={saveEdit} className="approval-edit">
          {"title" in p && (
            <label className="field">
              <span>{a.noun === "Reminder" ? "Remind me to" : "What"}</span>
              <input value={form.title ?? ""} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </label>
          )}
          <div className="row gap" style={{ flexWrap: "wrap" }}>
            {"date" in p && (
              <label className="field">
                <span>Date</span>
                <input type="date" value={form.date ?? ""} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </label>
            )}
            {"time" in p && (
              <label className="field">
                <span>Time</span>
                <input type="time" value={form.time ?? ""} onChange={(e) => setForm({ ...form, time: e.target.value })} />
              </label>
            )}
            {"estimateMinutes" in p && (
              <label className="field" style={{ width: 140 }}>
                <span>Minutes</span>
                <input inputMode="numeric" value={form.estimateMinutes ?? ""} onChange={(e) => setForm({ ...form, estimateMinutes: e.target.value })} />
              </label>
            )}
            {"body" in p && (
              <label className="field" style={{ flex: 1 }}>
                <span>Message</span>
                <input value={form.body ?? ""} onChange={(e) => setForm({ ...form, body: e.target.value })} />
              </label>
            )}
          </div>
          <div className="approval-actions">
            <button className="btn small primary">Save changes</button>
            <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          <p className="small muted">After a change, Nikki asks you to confirm the new version: an earlier approval never carries over.</p>
        </form>
      )}
    </article>
  );
}
