import { FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AppActions } from "../App";
import type { AppState } from "../../shared/types";

/**
 * Email (Phase 1A): your Gmail, read-only. Search with plain words or Gmail's own search terms, open a
 * conversation as plain text, and jump to Gmail for anything else. Nothing here marks, moves, labels or deletes
 * email. This is separate from Nikki's Inbox (the bell), which holds things waiting for your approval.
 */

type Any = any;

const QUICK: [string, string][] = [
  ["Inbox", "in:inbox"],
  ["Unread", "in:inbox is:unread"],
  ["Important", "is:important"],
  ["Today", "newer_than:1d"],
  ["Sent", "in:sent"],
];

let pending: { accountId: string; threadId: string } | null = null;
/** Lets a chat card open a conversation here. */
export function openEmailThread(actions: AppActions, accountId: string, threadId: string) {
  pending = { accountId, threadId };
  actions.setView("email");
}

export function fmtMailDate(iso: string | null | undefined, tz: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  if (day(d) === day(new Date())) return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(d);
}

export function EmailView({ state, actions }: { state: AppState; actions: AppActions }) {
  const tz = state.timezone;
  const [query, setQuery] = useState("in:inbox");
  const [text, setText] = useState("");
  const [res, setRes] = useState<Any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<{ accountId: string; threadId: string } | null>(pending);
  const [accounts, setAccounts] = useState<Any[]>([]);
  const [accountId, setAccountId] = useState<string>("");

  useEffect(() => {
    pending = null;
    api<Any>("GET", "/api/google/status")
      .then((s) => {
        const usable = s.accounts.filter((a: Any) => a.status === "connected" && a.services.includes("gmail"));
        setAccounts(usable);
        setAccountId((id) => id || usable[0]?.id || "");
      })
      .catch(() => undefined);
  }, []);

  const search = useCallback(
    async (q: string, fresh = false) => {
      if (!accountId) return;
      setLoading(true);
      setErr(null);
      try {
        setRes(await api<Any>("GET", `/api/google/email/search?accountId=${encodeURIComponent(accountId)}&q=${encodeURIComponent(q)}&limit=25${fresh ? "&fresh=1" : ""}`));
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [accountId],
  );
  useEffect(() => {
    if (accountId) search(query);
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim() || "in:inbox";
    setQuery(q);
    search(q);
  };

  if (open) return <Conversation open={open} tz={tz} onBack={() => setOpen(null)} />;

  return (
    <div className="page email-page">
      <div className="page-head">
        <h1 className="h2">Email</h1>
        <p className="muted small">Your Gmail, read-only. Nikki never marks, moves, labels or deletes anything. For approvals, use the Inbox (the bell).</p>
      </div>
      {!accounts.length ? (
        <div className="card">
          <p className="small muted">Gmail isn’t connected. Connect it in Context → Accounts.</p>
          <button className="btn small" onClick={() => actions.setView("context")}>Open Accounts</button>
        </div>
      ) : (
        <div className="card">
          <form className="email-search" onSubmit={submit} role="search">
            {accounts.length > 1 && (
              <select aria-label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email}
                  </option>
                ))}
              </select>
            )}
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search Gmail, e.g. from:asha contract" aria-label="Search Gmail" />
            <button className="btn primary" disabled={loading}>Search</button>
          </form>
          <div className="chips email-quick">
            {QUICK.map(([label, q]) => (
              <button key={q} className={`chip ${query === q ? "on" : ""}`} onClick={() => (setQuery(q), setText(""), search(q))}>
                {label}
              </button>
            ))}
          </div>
          {err && <p className="error-text small">{err}</p>}
          {loading && !res && <p className="muted small">Fetching from Gmail…</p>}
          {res && (
            <>
              <p className="small muted source-line">
                {res.threads.length ? `${res.threads.length}${res.more ? "+" : ""} conversations` : "No conversations"} · from Gmail {fmtAgo(res.fetchedAt)} · {res.account.email} ·{" "}
                <button className="link" onClick={() => search(query, true)} disabled={loading}>refresh</button> ·{" "}
                <a className="link" href={res.gmailSearchUrl} target="_blank" rel="noreferrer">open this search in Gmail</a>
              </p>
              {res.threads.length === 0 ? (
                <p className="empty-note small">Nothing matched “{res.query}”. Try fewer words, or a name or email address.</p>
              ) : (
                <ul className="mail-list">
                  {res.threads.map((t: Any) => (
                    <li key={t.threadId}>
                      <button className={`mail-row ${t.unread ? "unread" : ""}`} onClick={() => setOpen({ accountId: t.accountId, threadId: t.threadId })}>
                        <span className="mail-from">
                          {t.unread && <span className="unread-dot" aria-label="unread" />}
                          {t.sender}
                          {t.messageCount > 1 && <span className="muted"> ({t.messageCount})</span>}
                        </span>
                        <span className="mail-date muted">{fmtMailDate(t.date, tz)}</span>
                        <span className="mail-subject">
                          {t.important && <span className="tag subtle">Important</span>}
                          {t.subject}
                        </span>
                        {t.snippet && <span className="mail-snippet muted">{t.snippet}</span>}
                        {t.flagged.length > 0 && <span className="mail-snippet warn-text">{t.flagged[0]}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function fmtAgo(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

function Conversation({ open, tz, onBack }: { open: { accountId: string; threadId: string }; tz: string; onBack: () => void }) {
  const [c, setC] = useState<Any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Any>("GET", `/api/google/email/${encodeURIComponent(open.accountId)}/threads/${encodeURIComponent(open.threadId)}`)
      .then(setC)
      .catch((e) => setErr((e as Error).message));
  }, [open.accountId, open.threadId]);
  return (
    <div className="page email-page">
      <div className="row gap center-y wrap email-thread-head">
        <button className="btn small ghost" onClick={onBack}>← Back</button>
        {c && (
          <a className="btn small" href={c.link} target="_blank" rel="noreferrer">
            Open in Gmail
          </a>
        )}
      </div>
      {err && <div className="card"><p className="error-text small">{err}</p></div>}
      {!c && !err && <div className="card"><p className="muted small">Opening from Gmail…</p></div>}
      {c && (
        <div className="card">
          <h1 className="h3 mail-thread-subject">{c.subject}</h1>
          <p className="small muted">From Gmail · {c.account.email} · read-only. This email came from outside Nikki: treat its links and requests with care.</p>
          {c.messages.map((m: Any) => (
            <article key={m.id} className="mail-message">
              <header className="small">
                <strong>{m.sender}</strong> {m.senderEmail && m.senderEmail !== m.sender && <span className="muted">&lt;{m.senderEmail}&gt;</span>}
                <span className="muted"> · {m.date ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(m.date)) : ""}</span>
                {m.to.length > 0 && <div className="muted">To: {m.to.join(", ")}</div>}
                {m.cc.length > 0 && <div className="muted">Cc: {m.cc.join(", ")}</div>}
              </header>
              <div className="mail-body">{m.body || "(No text. Open in Gmail to see it.)"}</div>
              {m.attachments.length > 0 && (
                <p className="small muted">
                  Attachments: {m.attachments.map((a: Any) => a.filename).join(", ")} · open in Gmail to view them.
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
