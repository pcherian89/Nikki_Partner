import { clockIso, getSetting, newId, setSetting, type DB } from "../db.js";
import { currentInstant, localNow } from "../time.js";
import { sendPush } from "../push.js";
import { logActivity } from "./activity.js";

/**
 * The notification centre. Every notification is stored first (history, read/unread), then pushed to devices if the
 * user's preferences allow it. In-app is the source of truth; push is a best-effort copy that is never assumed to
 * have arrived (see push.ts: a device only counts as verified after it acknowledges a test).
 */

export const CATEGORIES = ["reminder", "approval", "agent", "budget", "security", "system"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Priority = "low" | "normal" | "high" | "urgent";

export interface NotificationPrefs {
  /** Push on/off per category (in-app history is always kept). */
  push: Record<Category, boolean>;
  quietHours: { enabled: boolean; start: string; end: string };
  /** When false (default), sensitive notifications push a generic line ("Nikki has something for you") instead of the content. */
  showSensitivePreviews: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  push: { reminder: true, approval: true, agent: false, budget: true, security: true, system: false },
  quietHours: { enabled: true, start: "22:00", end: "07:00" },
  showSensitivePreviews: false,
};

export const CATEGORY_LABEL: Record<Category, string> = {
  reminder: "Reminders",
  approval: "Approvals",
  agent: "Agent updates",
  budget: "AI budget",
  security: "Security",
  system: "System",
};

export function getPrefs(db: DB): NotificationPrefs {
  try {
    const raw = JSON.parse(getSetting(db, "notification_prefs") ?? "{}");
    return { ...DEFAULT_PREFS, ...raw, push: { ...DEFAULT_PREFS.push, ...(raw.push ?? {}) }, quietHours: { ...DEFAULT_PREFS.quietHours, ...(raw.quietHours ?? {}) } };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(db: DB, p: NotificationPrefs) {
  setSetting(db, "notification_prefs", JSON.stringify(p));
}

/** The time zone notifications are judged in: the user's last known zone, India by default. */
export const notifyTz = (db: DB) => getSetting(db, "last_timezone") || "Asia/Kolkata";

export function inQuietHours(p: NotificationPrefs, tz: string, at?: Date): boolean {
  if (!p.quietHours.enabled) return false;
  const t = localNow(tz, at).time;
  const { start, end } = p.quietHours;
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

export interface NotificationItem {
  id: string;
  createdAt: string;
  category: Category;
  priority: Priority;
  title: string;
  body: string;
  sensitive: boolean;
  link: string | null;
  spaceId: string | null;
  readAt: string | null;
  pushStatus: "none" | "sent" | "no_device" | "failed" | "held" | "off" | "digested";
}

type Row = {
  id: string;
  created_at: string;
  category: Category;
  priority: Priority;
  title: string;
  body: string;
  sensitive: number;
  link: string | null;
  space_id: string | null;
  read_at: string | null;
  push_status: NotificationItem["pushStatus"];
};
const toItem = (r: Row): NotificationItem => ({
  id: r.id,
  createdAt: r.created_at,
  category: r.category,
  priority: r.priority,
  title: r.title,
  body: r.body,
  sensitive: !!r.sensitive,
  link: r.link,
  spaceId: r.space_id,
  readAt: r.read_at,
  pushStatus: r.push_status,
});

/** Only in-app paths are allowed as deep links, so a notification can never send the user to another site. */
export function safeLink(link: string | null | undefined): string | null {
  if (!link) return null;
  return /^\/(?!\/)[\w\-./?=&#%]*$/.test(link) ? link : null;
}

const unreadCount = (db: DB) => (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL").get() as { n: number }).n;

/** Absolute URL of the app, when known: needed for Declarative Web Push (Safari opens it without the service worker). */
function publicOrigin(): string | null {
  const u = process.env.PUBLIC_URL?.trim() || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  return /^https:\/\/[\w.-]+(:\d+)?$/.test(u.replace(/\/$/, "")) ? u.replace(/\/$/, "") : null;
}

/** The push payload. Works with Nikki's service worker and, when the origin is known, as a Declarative Web Push message. */
export function pushPayload(n: Pick<NotificationItem, "id" | "category" | "title" | "body" | "sensitive" | "link">, prefs: NotificationPrefs, badge: number, kind?: string) {
  const hide = n.sensitive && !prefs.showSensitivePreviews;
  const title = hide ? "Nikki" : n.title;
  const body = hide ? `New ${CATEGORY_LABEL[n.category].toLowerCase().replace(/s$/, "")} item. Open Nikki to see it.` : n.body;
  const url = n.link ?? "/";
  const payload: Record<string, unknown> = { kind: kind ?? n.category, id: n.id, title, body, tag: n.id, url, badge };
  const origin = publicOrigin();
  if (origin) {
    payload.web_push = 8030;
    payload.notification = { title, body, navigate: origin + url, tag: n.id, silent: false };
    payload.app_badge = badge;
  }
  return payload;
}

export interface NotifyInput {
  category: Category;
  priority?: Priority;
  title: string;
  body?: string;
  sensitive?: boolean;
  link?: string | null;
  spaceId?: string | null;
  /** The same key twice creates one notification (for example "budget:2026-11:75"). */
  dedupeKey?: string | null;
  /** Payload `kind` for the service worker (kept for compatibility with reminder pushes). */
  kind?: string;
  /** Reminders the user set for a time are delivered even in quiet hours. */
  bypassQuiet?: boolean;
}

export async function notify(db: DB, input: NotifyInput): Promise<{ item: NotificationItem; created: boolean; pushed: number }> {
  if (input.dedupeKey) {
    const existing = db.prepare("SELECT * FROM notifications WHERE dedupe_key = ?").get(input.dedupeKey) as Row | undefined;
    if (existing) return { item: toItem(existing), created: false, pushed: 0 };
  }
  const id = newId("ntf");
  const priority = input.priority ?? "normal";
  db.prepare(
    "INSERT INTO notifications (id, created_at, category, priority, title, body, sensitive, link, space_id, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, clockIso(), input.category, priority, input.title.slice(0, 140), (input.body ?? "").slice(0, 600), input.sensitive ? 1 : 0, safeLink(input.link), input.spaceId ?? null, input.dedupeKey ?? null);
  const prefs = getPrefs(db);
  let status: NotificationItem["pushStatus"];
  let pushed = 0;
  if (!prefs.push[input.category]) status = "off";
  else if (!input.bypassQuiet && priority !== "urgent" && inQuietHours(prefs, notifyTz(db))) status = "held";
  else {
    try {
      const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as Row;
      pushed = await sendPush(db, pushPayload(toItem(row), prefs, unreadCount(db), input.kind), priority === "low" ? "normal" : "high");
      status = pushed > 0 ? "sent" : "no_device";
    } catch {
      status = "failed";
    }
  }
  db.prepare("UPDATE notifications SET push_status = ?, push_at = ? WHERE id = ?").run(status, status === "sent" ? clockIso() : null, id);
  return { item: toItem(db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as Row), created: true, pushed };
}

/** After quiet hours: one summary push for everything that was held. Run by the job runner. */
export async function sendQuietDigest(db: DB): Promise<number> {
  const prefs = getPrefs(db);
  if (inQuietHours(prefs, notifyTz(db))) return 0;
  const held = db.prepare("SELECT id FROM notifications WHERE push_status = 'held' AND read_at IS NULL").all() as { id: string }[];
  if (!held.length) return 0;
  db.prepare("UPDATE notifications SET push_status = 'digested' WHERE push_status = 'held'").run();
  const n = held.length;
  await sendPush(db, { kind: "digest", id: "digest", title: "Nikki", body: `${n} update${n === 1 ? "" : "s"} arrived during quiet hours.`, tag: "nikki-digest", url: "/?view=inbox", badge: unreadCount(db) }, "normal");
  return n;
}

export function listNotifications(db: DB, opts: { limit?: number; unreadOnly?: boolean; category?: Category } = {}): { items: NotificationItem[]; unread: number } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.unreadOnly) where.push("read_at IS NULL");
  if (opts.category) {
    where.push("category = ?");
    args.push(opts.category);
  }
  const rows = db
    .prepare(`SELECT * FROM notifications ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...args, opts.limit ?? 50) as Row[];
  return { items: rows.map(toItem), unread: unreadCount(db) };
}

export function markRead(db: DB, ids: string[] | "all", read = true) {
  const at = read ? clockIso() : null;
  if (ids === "all") db.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").run(at);
  else for (const id of ids) db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?").run(at, id);
}

/** Keeps the history bounded: read items older than 90 days are removed. */
export function pruneNotifications(db: DB) {
  const cutoff = new Date(currentInstant().getTime() - 90 * 86400_000).toISOString();
  const r = db.prepare("DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?").run(cutoff);
  if (r.changes) logActivity(db, "system", "notifications.pruned", null, { count: r.changes });
  return r.changes;
}
