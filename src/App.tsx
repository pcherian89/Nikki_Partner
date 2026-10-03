import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState, Workspace } from "../shared/types";
import { api, ApiError, newRequestId, setApiWorkspace } from "./api";
import { Avatar } from "./components/Avatar";
import { Chat } from "./components/Chat";
import { ContextView } from "./components/ContextView";
import { Everything } from "./components/Everything";
import { Login } from "./components/Login";
import { Today } from "./components/Today";
import { Welcome } from "./components/Welcome";

export type View = "today" | "everything" | "context";

export interface Toast {
  text: string;
  tone?: "info" | "error";
  action?: { label: string; run: () => void };
  details?: string[];
}

export interface PendingSend {
  text: string;
  requestId: string;
  kind: "chat" | "review" | "replan";
  remainingUntil?: string | null;
}

export interface AppActions {
  /** Runs an API call that returns new state; shows errors as a toast. Returns true on success. */
  mutate: (method: string, url: string, body?: unknown) => Promise<boolean>;
  send: (text: string, kind?: "chat" | "review") => Promise<boolean>;
  replan: (remainingUntil: string | null, note?: string) => Promise<boolean>;
  setState: (s: AppState) => void;
  toast: (t: Toast) => void;
  switchWorkspace: (ws: Workspace) => void;
  setView: (v: View) => void;
  focusComposer: (prefill?: string) => void;
}

const WS_KEY = "nikki.workspace";

function readStoredWorkspace(): Workspace | null {
  try {
    const v = localStorage.getItem(WS_KEY);
    return v === "demo" || v === "personal" ? v : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [authNeeded, setAuthNeeded] = useState<boolean | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("today");
  const [pane, setPane] = useState<"nikki" | "plan">("nikki");
  const [toast, setToastState] = useState<Toast | null>(null);
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [sendError, setSendError] = useState<{ message: string; send: PendingSend } | null>(null);
  const [composer, setComposer] = useState({ text: "", focusTick: 0 });
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((t: Toast) => {
    setToastState(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastState(null), t.tone === "error" ? 9000 : 6000);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api("GET", "/api/state");
      setState(r.state);
      setLoadError(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "auth_required") setAuthNeeded(true);
      else setLoadError((e as Error).message);
    }
  }, []);

  // Startup: auth -> choose workspace -> load saved state (no model call).
  useEffect(() => {
    (async () => {
      try {
        const auth = await api<{ authRequired: boolean; authed: boolean }>("GET", "/api/auth/status");
        if (auth.authRequired && !auth.authed) {
          setAuthNeeded(true);
          return;
        }
        setAuthNeeded(false);
        const health = await api<{ liveAvailable: boolean }>("GET", "/api/health");
        const chosen = readStoredWorkspace() ?? (health.liveAvailable ? "personal" : "demo");
        setApiWorkspace(chosen);
        setWs(chosen);
      } catch (e) {
        setLoadError((e as Error).message);
      }
    })();
  }, []);

  useEffect(() => {
    if (ws) load();
  }, [ws, load]);

  // Refresh saved state when returning to the tab (handles day changes). Never calls the model.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && ws && !pending) load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [ws, load, pending]);

  const switchWorkspace = useCallback((next: Workspace) => {
    try {
      localStorage.setItem(WS_KEY, next);
    } catch {
      /* storage unavailable */
    }
    setApiWorkspace(next);
    setState(null);
    setSendError(null);
    setWs(next);
    setView("today");
  }, []);

  const mutate = useCallback<AppActions["mutate"]>(
    async (method, url, body) => {
      try {
        const r = await api(method, url, body);
        if (r.state) setState(r.state);
        const warning = (r as { warning?: string }).warning;
        if (warning) showToast({ text: warning });
        return true;
      } catch (e) {
        const err = e as ApiError;
        showToast({ text: err.message, tone: "error", details: err.details });
        if (err.code === "stale") load();
        return false;
      }
    },
    [showToast, load],
  );

  const doSend = useCallback(
    async (p: PendingSend) => {
      if (pending) return false;
      setPending(p);
      setSendError(null);
      try {
        const r =
          p.kind === "replan"
            ? await api("POST", "/api/replan", { clientRequestId: p.requestId, remainingUntil: p.remainingUntil ?? null, note: p.text })
            : await api("POST", "/api/messages", { text: p.text, clientRequestId: p.requestId, kind: p.kind });
        setState(r.state);
        if (r.state.proposal?.plan) setPane((cur) => cur);
        return true;
      } catch (e) {
        setSendError({ message: (e as Error).message, send: p });
        return false;
      } finally {
        setPending(null);
      }
    },
    [pending],
  );

  const actions: AppActions = {
    mutate,
    send: (text, kind = "chat") => doSend({ text, kind, requestId: newRequestId() }),
    replan: (remainingUntil, note) => doSend({ text: note ?? "", kind: "replan", requestId: newRequestId(), remainingUntil }),
    setState,
    toast: showToast,
    switchWorkspace,
    setView,
    focusComposer: (prefill) => {
      setView("today");
      setPane("nikki");
      setComposer((c) => ({ text: prefill ?? c.text, focusTick: c.focusTick + 1 }));
    },
  };

  if (authNeeded) return <Login onDone={() => window.location.reload()} />;

  if (loadError && !state) {
    return (
      <div className="center-screen">
        <Avatar size={96} />
        <p className="muted">{loadError}</p>
        <button className="btn primary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  }

  if (!state || !ws) {
    return (
      <div className="center-screen">
        <Avatar size={72} className="pulse" />
        <p className="muted">Loading your plan…</p>
      </div>
    );
  }

  const showWelcome = view === "today" && !state.hasAnyData && !pending;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Avatar size={30} />
          <span>Nikki Partner</span>
        </div>
        <nav className="tabs" aria-label="Views">
          {(
            [
              ["today", "Today"],
              ["everything", "Everything"],
              ["context", "My context"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={`tab ${view === k ? "active" : ""}`} onClick={() => setView(k)} aria-current={view === k}>
              {label}
            </button>
          ))}
        </nav>
        <ModeBadge state={state} onClick={() => setView("context")} />
      </header>

      <main className="main">
        {view === "today" &&
          (showWelcome ? (
            <Welcome state={state} actions={actions} sendError={sendError?.message ?? null} />
          ) : (
            <div className={`today-layout pane-${pane}`}>
              <div className="pane-switch" role="tablist">
                <button role="tab" aria-selected={pane === "nikki"} className={pane === "nikki" ? "active" : ""} onClick={() => setPane("nikki")}>
                  Nikki
                </button>
                <button role="tab" aria-selected={pane === "plan"} className={pane === "plan" ? "active" : ""} onClick={() => setPane("plan")}>
                  Today's plan{state.proposal ? <span className="dot" aria-label="proposal waiting" /> : null}
                </button>
              </div>
              <section className="col-chat" aria-label="Conversation with Nikki">
                <Chat
                  state={state}
                  actions={actions}
                  pending={pending}
                  sendError={sendError}
                  onRetry={() => sendError && doSend(sendError.send)}
                  onDismissError={() => setSendError(null)}
                  composer={composer}
                  onShowPlan={() => {
                    setPane("plan");
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                />
              </section>
              <section className="col-plan" aria-label="Today's plan">
                <Today state={state} actions={actions} busy={!!pending} />
              </section>
            </div>
          ))}
        {view === "everything" && <Everything state={state} actions={actions} />}
        {view === "context" && <ContextView state={state} actions={actions} />}
      </main>

      {toast && (
        <div className={`toast ${toast.tone === "error" ? "error" : ""}`} role="status" aria-live="polite">
          <div>
            <div>{toast.text}</div>
            {toast.details?.length ? (
              <ul className="toast-details">
                {toast.details.slice(0, 4).map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            ) : null}
          </div>
          {toast.action && (
            <button
              className="btn small ghost"
              onClick={() => {
                toast.action!.run();
                setToastState(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setToastState(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function ModeBadge({ state, onClick }: { state: AppState; onClick: () => void }) {
  if (state.workspace === "demo") {
    return (
      <button className="mode-badge demo" onClick={onClick} title="Scripted replies — no AI. Click to change.">
        Demo mode
      </button>
    );
  }
  return (
    <button
      className={`mode-badge ${state.liveAvailable ? "live" : "off"}`}
      onClick={onClick}
      title={state.liveAvailable ? `Replies from Claude (${state.model})` : "No API key configured on the server"}
    >
      {state.liveAvailable ? "Live AI" : "Live AI off"}
    </button>
  );
}
