import type { AppActions } from "../App";
import { fmtMailDate, openEmailThread } from "./Email";

/** Chat cards for email and calendar answers (Phase 1A): the facts, their source, and how fresh they are. */

type Any = any;

const ago = (iso: string | null | undefined) => {
  if (!iso) return "not yet";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const h12 = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const dayLabel = (d: string, today: string) => {
  if (d === today) return "Today";
  const dt = new Date(`${d}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(dt);
};

export function GoogleCard({ g, tz, actions }: { g: Any; tz: string; actions: AppActions }) {
  if (g.kind === "email") {
    return (
      <div className="g-card">
        {g.items?.length > 0 && (
          <ul className="g-list">
            {g.items.map((i: Any) => (
              <li key={i.threadId}>
                <button className={`g-row mail ${i.unread ? "unread" : ""}`} onClick={() => openEmailThread(actions, i.accountId, i.threadId)}>
                  <span className="g-main">
                    <strong>
                      {i.unread && <span className="unread-dot" aria-label="unread" />}
                      {i.sender}
                    </strong>
                    <span className="g-sub">{i.subject}</span>
                  </span>
                  <span className="g-when muted">{fmtMailDate(i.date, tz)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="g-source small muted">
          {g.source} · fetched {ago(g.fetchedAt)}
          {g.gmailSearchUrl && (
            <>
              {" · "}
              <a className="link" href={g.gmailSearchUrl} target="_blank" rel="noreferrer">
                open in Gmail
              </a>
            </>
          )}
        </p>
      </div>
    );
  }
  if (g.kind === "calendar") {
    const multi = g.from !== g.to;
    const rows = [
      ...(g.allDay ?? []).map((a: Any) => ({ key: a.id, date: a.date, when: "All day", sortKey: "", title: a.title, source: "Google Calendar", link: a.link })),
      ...(g.items ?? []).map((i: Any) => ({ key: i.id, date: i.date, when: `${h12(i.start)}–${h12(i.end)}`, sortKey: i.start, title: i.title, source: i.source, link: i.link, location: i.location })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.sortKey.localeCompare(b.sortKey));
    return (
      <div className="g-card">
        {rows.length > 0 && (
          <ul className="g-list">
            {rows.map((r) => (
              <li key={r.key} className="g-row cal">
                <span className="g-when">{multi ? `${dayLabel(r.date, g.today)} · ` : ""}{r.when}</span>
                <span className="g-main">
                  <strong>{r.title}</strong>
                  <span className="g-sub muted">
                    {r.source}
                    {r.location ? ` · ${r.location}` : ""}
                    {r.link && (
                      <>
                        {" · "}
                        <a className="link" href={r.link} target="_blank" rel="noreferrer">open</a>
                      </>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {g.planBlocks?.length > 0 && <p className="small muted">Also in your plan: {g.planBlocks.slice(0, 4).map((b: Any) => `${h12(b.start)} ${b.title}`).join(", ")}{g.planBlocks.length > 4 ? "…" : ""}</p>}
        <p className="g-source small muted">
          {g.source} · Google Calendar updated {ago(g.lastSyncAt)}
        </p>
      </div>
    );
  }
  if (g.kind === "access" || g.kind === "notice") {
    return (
      <div className="g-card">
        <button className="btn small" onClick={() => actions.setView("context")}>
          Manage accounts
        </button>
      </div>
    );
  }
  return null;
}
