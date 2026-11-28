import { createHash } from "node:crypto";
import IcalExpander from "ical-expander";
import { clockIso, type DB } from "../db.js";
import { rebuildPlanMeetings } from "../planOps.js";
import { addDays, currentInstant, localNow, localToUtc, toMinutes } from "../time.js";
import { logActivity } from "../system/activity.js";
import { accessToken, googleAccount, markNeedsReconnect, usableAccounts, type GoogleAccount } from "./accounts.js";
import { callReadTool, GoogleError } from "./mcp.js";

/**
 * Google Calendar, read-only. Events from the chosen calendars (the main calendar by default) for yesterday to 31
 * days ahead are copied into Nikki's meetings (source "calendar", feed "google:<account>:<calendar>"), exactly like
 * the iCal links, so Today, Tomorrow, Week and the planner all see them. Extra details (link, location, calendar)
 * go in google_events. All-day events are kept for answers ("what's on tomorrow") but don't block planning time.
 *
 * Duplicates: when an iCal link shows the same calendar, the iCal copy of any event that Google also has (same day,
 * times and title) is dropped, so nothing appears twice. The iCal link itself is left alone; the app suggests
 * removing it.
 */

const SYNC_DAYS = 31;
export const STALE_MS = 10 * 60_000;
/** When Google Calendar itself can't be used (preview access, not enabled), try again only every 6 hours. */
export const UNAVAILABLE_RETRY_MS = 6 * 60 * 60_000;

/** True when the failure means Calendar access isn't offered for this account, rather than a passing problem. */
export function isUnavailable(e: unknown): boolean {
  if (!(e instanceof GoogleError)) return false;
  if (e.code === "forbidden") return true;
  return e.code === "server" && /preview|not enabled|not been used|disabled|permission/i.test(e.message);
}

export interface CalendarEntry {
  id: string;
  name: string;
  selected: boolean;
  primary?: boolean;
  skippedReason?: string;
}

const meetingId = (acct: string, cal: string, ev: string, startIso: string) => "cal_" + createHash("sha1").update(`google|${acct}|${cal}|${ev}|${startIso}`).digest("hex").slice(0, 16);
export const feedIdFor = (acct: string, cal: string) => `google:${acct}:${cal}`;

const call = (db: DB, acc: GoogleAccount, tool: string, args: Record<string, unknown>) =>
  callReadTool({ db, accountId: acc.id, product: "calendar", tool, args, token: (force) => accessToken(db, acc.id, force) });

/** Nikki's own subscribed plan feed must never be read back in (it would double every plan block). */
function skipReason(c: { id: string; summary?: string }): string | undefined {
  if (/import\.calendar\.google\.com$/.test(c.id) && /nikki/i.test(c.summary ?? "")) return "This is Nikki's own plan feed, so reading it back would show your plans twice.";
  return undefined;
}

/** Refreshes the list of calendars, keeping earlier choices. New accounts start with only the main calendar. */
export async function refreshCalendarList(db: DB, acc: GoogleAccount): Promise<CalendarEntry[]> {
  const items: { id: string; summary?: string }[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 4; i++) {
    const r = await call(db, acc, "list_calendars", { pageSize: 250, ...(pageToken ? { pageToken } : {}) });
    items.push(...((r.calendars ?? r.items ?? []) as { id: string; summary?: string }[]).filter((c) => c && typeof c.id === "string"));
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  const before = new Map(acc.calendars.map((c) => [c.id, c]));
  const email = (acc.email ?? "").toLowerCase();
  const next: CalendarEntry[] = items.map((c) => {
    const primary = c.id.toLowerCase() === email;
    const skipped = skipReason(c);
    const prev = before.get(c.id);
    return { id: c.id, name: (c.summary || c.id).slice(0, 80), primary, selected: !skipped && (prev ? prev.selected : primary), ...(skipped ? { skippedReason: skipped } : {}) };
  });
  next.sort((a, b) => Number(!!b.primary) - Number(!!a.primary) || a.name.localeCompare(b.name));
  db.prepare("UPDATE connected_accounts SET calendars = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), clockIso(), acc.id);
  return next;
}

type Dt = { date?: string; dateTime?: string; timeZone?: string };
interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: Dt;
  end?: Dt;
  htmlLink?: string;
  location?: string;
  eventType?: string;
  recurrence?: string[];
  recurringEventId?: string;
  transparency?: string;
  availability?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
}

function instant(d: Dt | undefined, tz: string): Date | null {
  if (!d?.dateTime) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(d.dateTime)) {
    const t = new Date(d.dateTime);
    return Number.isNaN(t.getTime()) ? null : t;
  }
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(d.dateTime);
  return m ? localToUtc(m[1], m[2], d.timeZone || tz) : null;
}

const SKIP_TYPES = new Set(["WORKING_LOCATION", "BIRTHDAY", "workingLocation", "birthday"]);

/** Turns one Google event into Nikki rows: timed (meeting) or all-day (details only). Recurring masters are expanded. */
export function convertEvent(ev: GEvent, tz: string, from: Date, to: Date): { kind: "timed"; date: string; start: string; end: string; startIso: string; title: string }[] | { kind: "allday"; date: string; title: string }[] {
  if (!ev?.id || (ev.status ?? "").toLowerCase() === "cancelled") return [];
  if (ev.eventType && SKIP_TYPES.has(ev.eventType)) return [];
  if (ev.attendees?.some((a) => a.self && (a.responseStatus ?? "").toLowerCase() === "declined")) return [];
  if ((ev.transparency ?? "").toLowerCase() === "transparent" || /free/i.test(ev.availability ?? "")) return [];
  const title = (ev.summary || "Busy").trim().slice(0, 200);
  if (ev.start?.date && !ev.start.dateTime) {
    // All-day: one entry per day it covers (end date is exclusive), within the window.
    const out: { kind: "allday"; date: string; title: string }[] = [];
    const last = ev.end?.date ? addDays(ev.end.date, -1) : ev.start.date;
    const lo = localNow(tz, from).date;
    const hi = localNow(tz, to).date;
    for (let d = ev.start.date, i = 0; d <= last && i < 31; d = addDays(d, 1), i++) if (d >= lo && d <= hi) out.push({ kind: "allday", date: d, title });
    return out;
  }
  const s = instant(ev.start, tz);
  const e = instant(ev.end, tz);
  if (!s || !e || !(e > s)) return [];
  let starts: { s: Date; e: Date }[] = [{ s, e }];
  if (ev.recurrence?.length && !ev.recurringEventId) starts = expandRecurrence(ev.recurrence, s, e, from, to);
  const out: { kind: "timed"; date: string; start: string; end: string; startIso: string; title: string }[] = [];
  for (const o of starts) {
    if (o.e.getTime() - o.s.getTime() > 16 * 3_600_000 || o.e < from || o.s > to) continue;
    const ls = localNow(tz, o.s);
    const le = localNow(tz, o.e);
    const end = le.date === ls.date ? le.time : "23:59";
    if (toMinutes(end) <= toMinutes(ls.time)) continue;
    out.push({ kind: "timed", date: ls.date, start: ls.time, end, startIso: o.s.toISOString(), title });
  }
  return out;
}

/** If Google returns a repeating event's master instead of its instances, expand it here (times kept in UTC). */
function expandRecurrence(lines: string[], s: Date, e: Date, from: Date, to: Date): { s: Date; e: Date }[] {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const safe = lines.filter((l) => /^(RRULE|EXDATE|RDATE)[:;]/.test(l));
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:x", `DTSTART:${fmt(s)}`, `DTEND:${fmt(e)}`, ...safe, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  try {
    const { events, occurrences } = new IcalExpander({ ics, maxIterations: 500, skipInvalidDates: true }).between(from, to);
    const len = e.getTime() - s.getTime();
    const all = [...events.map((x) => x.startDate.toJSDate()), ...occurrences.map((o) => o.startDate.toJSDate())];
    return all.map((d) => ({ s: d, e: new Date(d.getTime() + len) }));
  } catch {
    return [{ s, e }];
  }
}

export interface SyncResult {
  accountId: string;
  ok: boolean;
  events: number;
  allDay: number;
  calendars: number;
  error?: string;
}

const inFlight = new Map<string, Promise<SyncResult>>();

/** Copies upcoming events for one account. Safe to call often: concurrent calls share one run. */
export function syncGoogleCalendar(db: DB, accountId: string, tz: string): Promise<SyncResult> {
  const running = inFlight.get(accountId);
  if (running) return running;
  const p = doSync(db, accountId, tz).finally(() => inFlight.delete(accountId));
  inFlight.set(accountId, p);
  return p;
}

async function doSync(db: DB, accountId: string, tz: string): Promise<SyncResult> {
  const acc = googleAccount(db, accountId);
  if (!acc || acc.status !== "connected" || !acc.services.includes("calendar")) return { accountId, ok: false, events: 0, allDay: 0, calendars: 0, error: "Calendar isn't connected for this account." };
  db.prepare("UPDATE connected_accounts SET sync_status = 'syncing' WHERE id = ?").run(accountId);
  const now = currentInstant();
  const today = localNow(tz, now).date;
  const fromDate = addDays(today, -1);
  const from = localToUtc(fromDate, "00:00", tz);
  const to = localToUtc(addDays(today, SYNC_DAYS), "00:00", tz);
  try {
    const calendars = await refreshCalendarList(db, acc);
    const chosen = calendars.filter((c) => c.selected);
    const timed: { mid: string; cal: CalendarEntry; ev: GEvent; date: string; start: string; end: string; title: string }[] = [];
    const allDay: { mid: string; cal: CalendarEntry; ev: GEvent; date: string; title: string }[] = [];
    for (const cal of chosen) {
      let pageToken: string | undefined;
      for (let page = 0; page < 6; page++) {
        const r = await call(db, acc, "list_events", {
          calendarId: cal.id,
          startTime: `${fromDate}T00:00:00`,
          endTime: `${addDays(today, SYNC_DAYS)}T00:00:00`,
          timeZone: tz,
          pageSize: 250,
          orderBy: "startTime",
          ...(pageToken ? { pageToken } : {}),
        });
        for (const ev of (r.events ?? r.items ?? []) as GEvent[]) {
          for (const o of convertEvent(ev, tz, from, to)) {
            if (o.kind === "timed") timed.push({ mid: meetingId(acc.id, cal.id, ev.id, o.startIso), cal, ev, date: o.date, start: o.start, end: o.end, title: o.title });
            else allDay.push({ mid: meetingId(acc.id, cal.id, ev.id, `${o.date}`), cal, ev, date: o.date, title: o.title });
          }
        }
        pageToken = r.nextPageToken;
        if (!pageToken) break;
      }
    }
    const seen = new Set<string>();
    const stamp = clockIso();
    db.transaction(() => {
      db.prepare("DELETE FROM meetings WHERE feed_id LIKE ? AND date >= ?").run(`google:${acc.id}:%`, fromDate);
      db.prepare("DELETE FROM google_events WHERE account_id = ? AND (date IS NULL OR date >= ?)").run(acc.id, fromDate);
      const insM = db.prepare("INSERT OR REPLACE INTO meetings (id, date, title, start, end, created_at, deleted, source, feed_id) VALUES (?, ?, ?, ?, ?, ?, 0, 'calendar', ?)");
      const insG = db.prepare(
        "INSERT OR REPLACE INTO google_events (meeting_id, account_id, calendar_id, calendar_name, event_id, date, title, html_link, location, all_day, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const t of timed) {
        if (seen.has(t.mid)) continue;
        seen.add(t.mid);
        insM.run(t.mid, t.date, t.title, t.start, t.end, stamp, feedIdFor(acc.id, t.cal.id));
        insG.run(t.mid, acc.id, t.cal.id, t.cal.name, t.ev.id, t.date, t.title, safeLink(t.ev.htmlLink), t.ev.location?.slice(0, 200) ?? null, 0, stamp);
      }
      for (const a of allDay) {
        if (seen.has(a.mid)) continue;
        seen.add(a.mid);
        insG.run(a.mid, acc.id, a.cal.id, a.cal.name, a.ev.id, a.date, a.title, safeLink(a.ev.htmlLink), a.ev.location?.slice(0, 200) ?? null, 1, stamp);
      }
      db.prepare("UPDATE connected_accounts SET sync_status = 'ok', last_sync_at = ?, last_error = NULL WHERE id = ?").run(stamp, acc.id);
    })();
    dropIcalDuplicates(db, fromDate);
    for (const d of [today, addDays(today, 1)]) rebuildPlanMeetings(db, d, today);
    return { accountId, ok: true, events: timed.length, allDay: allDay.length, calendars: chosen.length };
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof GoogleError && e.code === "auth") await markNeedsReconnect(db, accountId, msg);
    const status = isUnavailable(e) ? "unavailable" : "error";
    if (status === "unavailable") {
      // Google Calendar can't be used for this account: drop Nikki's copies so calendar links (iCal) are the only
      // source again and nothing stale or doubled stays on the plan. Your own records are never touched.
      db.prepare("DELETE FROM meetings WHERE feed_id LIKE ? AND date >= ?").run(`google:${acc.id}:%`, fromDate);
      db.prepare("DELETE FROM google_events WHERE account_id = ? AND (date IS NULL OR date >= ?)").run(acc.id, fromDate);
      const { getFeeds, syncFeed } = await import("../calendar.js");
      for (const f of getFeeds(db)) await syncFeed(db, f.id, tz).catch(() => undefined); // restore any iCal copies
      for (const d of [today, addDays(today, 1)]) rebuildPlanMeetings(db, d, today);
    }
    db.prepare("UPDATE connected_accounts SET sync_status = ?, last_error = ?, last_sync_at = ? WHERE id = ?").run(status, msg, clockIso(), accountId);
    logActivity(db, "system", "google.calendar_sync_failed", accountId, { reason: e instanceof GoogleError ? e.code : "error" }, acc.spaceId);
    return { accountId, ok: false, events: 0, allDay: 0, calendars: 0, error: msg };
  }
}

/** Only Google Calendar web addresses are kept as event links. */
function safeLink(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && /(^|\.)google\.com$/.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Removes iCal copies of events that a connected Google calendar already provides. Returns how many were dropped. */
export function dropIcalDuplicates(db: DB, fromDate: string): number {
  const google = db.prepare("SELECT date, start, end, title FROM meetings WHERE source = 'calendar' AND feed_id LIKE 'google:%' AND deleted = 0 AND date >= ?").all(fromDate) as { date: string; start: string; end: string; title: string }[];
  if (!google.length) return 0;
  const keys = new Set(google.map((g) => `${g.date}|${g.start}|${g.end}|${norm(g.title)}`));
  const ical = db.prepare("SELECT id, date, start, end, title FROM meetings WHERE source = 'calendar' AND (feed_id IS NULL OR feed_id NOT LIKE 'google:%') AND date >= ?").all(fromDate) as { id: string; date: string; start: string; end: string; title: string }[];
  const del = db.prepare("DELETE FROM meetings WHERE id = ?");
  let n = 0;
  for (const m of ical) if (keys.has(`${m.date}|${m.start}|${m.end}|${norm(m.title)}`)) n += del.run(m.id).changes;
  return n;
}

/** iCal links that look like the same Google calendar as a connected account (so the app can suggest removing them). */
export function overlappingFeeds(db: DB, feeds: { id: string; name: string; url: string }[]) {
  const emails = usableAccounts(db, "calendar").map((a) => (a.email ?? "").toLowerCase()).filter(Boolean);
  return feeds
    .filter((f) => {
      const u = decodeURIComponent(f.url).toLowerCase();
      return u.includes("calendar.google.com") && emails.some((e) => u.includes(`/${e}/`) || u.includes(e));
    })
    .map((f) => ({ id: f.id, name: f.name }));
}

const lastAuto = new Map<string, number>();
/** Background refresh: accounts not synced in the last 10 minutes. Never throws. */
export function syncGoogleStale(db: DB, tz: string) {
  for (const a of usableAccounts(db, "calendar")) {
    const last = a.lastSyncAt ? Date.parse(a.lastSyncAt) : 0;
    const tried = lastAuto.get(a.id) ?? 0;
    if (Date.now() - Math.max(last, tried) < (a.syncStatus === "unavailable" ? UNAVAILABLE_RETRY_MS : STALE_MS)) continue;
    lastAuto.set(a.id, Date.now());
    syncGoogleCalendar(db, a.id, tz).catch(() => undefined);
  }
}

/** Events for a range of days from every source, for answers and the calendar card. */
export function eventsBetween(db: DB, from: string, to: string) {
  const rows = db
    .prepare(
      `SELECT m.id, m.date, m.title, m.start, m.end, m.source, m.feed_id AS feedId, g.html_link AS link, g.calendar_name AS calendarName, g.calendar_id AS calendarId, g.location, g.account_id AS accountId
       FROM meetings m LEFT JOIN google_events g ON g.meeting_id = m.id
       WHERE m.deleted = 0 AND m.date >= ? AND m.date <= ? ORDER BY m.date, m.start`,
    )
    .all(from, to) as { id: string; date: string; title: string; start: string; end: string; source: string; feedId: string | null; link: string | null; calendarName: string | null; calendarId: string | null; location: string | null; accountId: string | null }[];
  const allDay = db
    .prepare("SELECT meeting_id AS id, date, title, html_link AS link, calendar_name AS calendarName, account_id AS accountId FROM google_events WHERE all_day = 1 AND date >= ? AND date <= ? ORDER BY date, title")
    .all(from, to) as { id: string; date: string; title: string; link: string | null; calendarName: string | null; accountId: string }[];
  return { timed: rows, allDay };
}
