import { createHash } from "node:crypto";
import IcalExpander from "ical-expander";
import type { CalendarFeedInfo } from "../shared/types.js";
import { UserFacingError } from "./assistant.js";
import { DB, getSetting, newId, nowIso, setSetting } from "./db.js";
import { rebuildPlanMeetings } from "./planOps.js";
import { addDays, currentInstant, localNow, toMinutes } from "./time.js";

/**
 * Read-only calendar sync. The user pastes a private iCal (.ics) link from
 * Google Calendar or Apple iCloud; the server fetches it, expands repeating
 * events and stores the next 30 days as fixed meetings (source "calendar").
 * Nikki never writes to the calendar.
 */

interface Feed {
  id: string;
  name: string;
  url: string;
  lastSyncAt: string | null;
  lastError: string | null;
  eventCount: number;
}

const KEY = "calendar_feeds";
const SYNC_DAYS = 31;
const STALE_MS = 10 * 60 * 1000;
const MAX_BYTES = 5 * 1024 * 1024;

export function getFeeds(db: DB): Feed[] {
  try {
    return JSON.parse(getSetting(db, KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveFeeds(db: DB, feeds: Feed[]) {
  setSetting(db, KEY, JSON.stringify(feeds));
}

export function feedInfo(db: DB): CalendarFeedInfo[] {
  return getFeeds(db).map((f) => ({
    id: f.id,
    name: f.name,
    urlHint: hint(f.url),
    lastSyncAt: f.lastSyncAt,
    lastError: f.lastError,
    eventCount: f.eventCount,
  }));
}

function hint(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}/…${url.slice(-6)}`;
  } catch {
    return "…";
  }
}

export function normaliseUrl(raw: string) {
  const url = raw.trim().replace(/^webcals?:\/\//i, "https://");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UserFacingError("That doesn't look like a calendar link. Paste the full address (it starts with https:// or webcal://).");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UserFacingError("Calendar links must start with https:// or webcal://.");
  return u.toString();
}

async function fetchIcs(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "text/calendar, */*" }, redirect: "follow" });
    if (!res.ok) throw new Error(res.status === 404 ? "The calendar link wasn't found (404). It may have been reset." : `The calendar server answered ${res.status}.`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) throw new Error("This calendar is too large to sync.");
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("This calendar is too large to sync.");
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("That link didn't return a calendar. Make sure you copied the private iCal / public calendar link.");
    return text;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("The calendar took too long to respond.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface CalendarEvent {
  id: string;
  date: string;
  title: string;
  start: string;
  end: string;
}

/** Expands an .ics file into timed events (local to `tz`) between now and SYNC_DAYS ahead. All-day events are skipped. */
export function expandIcs(ics: string, feedId: string, tz: string, from: Date, days = SYNC_DAYS): CalendarEvent[] {
  const expander = new IcalExpander({ ics, maxIterations: 2000, skipInvalidDates: true });
  const to = new Date(from.getTime() + days * 86_400_000);
  const { events, occurrences } = expander.between(from, to);
  const out: CalendarEvent[] = [];
  const add = (uid: string, title: string, status: string | null, startDate: { isDate: boolean; toJSDate: () => Date }, endDate: { toJSDate: () => Date }) => {
    if (startDate.isDate) return; // all-day
    if (status && status.toUpperCase() === "CANCELLED") return;
    const s = startDate.toJSDate();
    const e = endDate.toJSDate();
    if (!(e > s) || e.getTime() - s.getTime() > 16 * 3_600_000) return;
    const ls = localNow(tz, s);
    const le = localNow(tz, e);
    const end = le.date === ls.date ? le.time : "23:59";
    if (toMinutes(end) <= toMinutes(ls.time)) return;
    const id = "cal_" + createHash("sha1").update(`${feedId}|${uid}|${s.toISOString()}`).digest("hex").slice(0, 16);
    out.push({ id, date: ls.date, title: (title || "Busy").trim().slice(0, 200), start: ls.time, end });
  };
  for (const ev of events) add(ev.uid, ev.summary, ev.component.getFirstPropertyValue("status") as string | null, ev.startDate, ev.endDate);
  for (const o of occurrences) add(o.item.uid, o.item.summary, o.item.component.getFirstPropertyValue("status") as string | null, o.startDate, o.endDate);
  out.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  // Same event listed twice (e.g. an exception and its master) -> keep one.
  return out.filter((e, i) => out.findIndex((x) => x.id === e.id) === i);
}

/** Replaces a feed's upcoming events with a fresh copy, then refreshes today's and tomorrow's plans. */
function storeEvents(db: DB, feedId: string, events: CalendarEvent[], today: string) {
  db.transaction(() => {
    db.prepare("DELETE FROM meetings WHERE source = 'calendar' AND feed_id = ? AND date >= ?").run(feedId, today);
    const ins = db.prepare(
      "INSERT OR REPLACE INTO meetings (id, date, title, start, end, created_at, deleted, source, feed_id) VALUES (?, ?, ?, ?, ?, ?, 0, 'calendar', ?)",
    );
    for (const e of events) if (e.date >= today) ins.run(e.id, e.date, e.title, e.start, e.end, nowIso(), feedId);
  })();
}

export async function syncFeed(db: DB, feedId: string, tz: string): Promise<{ warnings: string[] }> {
  const feeds = getFeeds(db);
  const feed = feeds.find((f) => f.id === feedId);
  if (!feed) throw new UserFacingError("Calendar not found.", 404, "not_found");
  const today = localNow(tz).date;
  try {
    const ics = await fetchIcs(feed.url);
    const events = expandIcs(ics, feed.id, tz, new Date(currentInstant().getTime() - 86_400_000));
    storeEvents(db, feed.id, events, today);
    feed.lastError = null;
    feed.eventCount = events.filter((e) => e.date >= today).length;
  } catch (e) {
    feed.lastError = (e as Error).message;
  }
  feed.lastSyncAt = nowIso();
  saveFeeds(db, feeds);
  const warnings = [today, addDays(today, 1)].map((d) => rebuildPlanMeetings(db, d, today)).filter((w): w is string => !!w);
  return { warnings };
}

export async function addFeed(db: DB, name: string, rawUrl: string, tz: string) {
  const url = normaliseUrl(rawUrl);
  const feeds = getFeeds(db);
  if (feeds.some((f) => f.url === url)) throw new UserFacingError("That calendar is already linked.");
  if (feeds.length >= 10) throw new UserFacingError("You can link up to 10 calendars.");
  // Check the link works before saving it.
  try {
    const ics = await fetchIcs(url);
    expandIcs(ics, "check", tz, currentInstant(), 1);
  } catch (e) {
    throw new UserFacingError(`Couldn't read that calendar: ${(e as Error).message}`, 422, "calendar_unreadable");
  }
  const feed: Feed = { id: newId("cal"), name: name.trim() || "Calendar", url, lastSyncAt: null, lastError: null, eventCount: 0 };
  saveFeeds(db, [...feeds, feed]);
  return syncFeed(db, feed.id, tz);
}

export function removeFeed(db: DB, feedId: string, tz: string) {
  const today = localNow(tz).date;
  saveFeeds(
    db,
    getFeeds(db).filter((f) => f.id !== feedId),
  );
  db.prepare("DELETE FROM meetings WHERE source = 'calendar' AND feed_id = ? AND date >= ?").run(feedId, today);
  [today, addDays(today, 1)].forEach((d) => rebuildPlanMeetings(db, d, today));
}

const syncing = new Set<DB>();

/** Syncs feeds that haven't synced in the last few minutes. Runs in the background; never throws. */
export function syncStale(db: DB, tz: string) {
  if (syncing.has(db)) return;
  const stale = getFeeds(db).filter((f) => !f.lastSyncAt || Date.now() - Date.parse(f.lastSyncAt) > STALE_MS);
  if (!stale.length) return;
  syncing.add(db);
  (async () => {
    for (const f of stale) await syncFeed(db, f.id, tz).catch(() => undefined);
  })().finally(() => syncing.delete(db));
}
