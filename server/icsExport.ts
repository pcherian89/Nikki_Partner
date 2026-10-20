import { randomBytes } from "node:crypto";
import type { Meeting, Plan, Task } from "../shared/types.js";
import { currentPlan, DB, getSetting, listMeetingsBetween, listTasks, setSetting } from "./db.js";
import { addDays, localNow } from "./time.js";

/**
 * "Nikki in your calendar": a private .ics feed of confirmed plans that the
 * user subscribes to from Google or Apple Calendar. The secret token in the URL
 * is the only protection (calendar apps can't log in), so it's long, random and
 * can be reset at any time.
 */

const KEY = "ics_feed_token";

export function getFeedToken(db: DB): string | null {
  return getSetting(db, KEY);
}

export function resetFeedToken(db: DB): string {
  const token = randomBytes(24).toString("hex");
  setSetting(db, KEY, token);
  return token;
}

export function disableFeed(db: DB) {
  setSetting(db, KEY, "");
}

/** Offset (ms) of `tz` from UTC at a given instant. */
function tzOffset(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - at.getTime();
}

/** Converts a local wall-clock date + time in `tz` to the real instant. */
export function localToUtc(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - tzOffset(new Date(guess), tz);
  t = guess - tzOffset(new Date(t), tz); // second pass handles DST edges
  return new Date(t);
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const dateOnly = (date: string) => date.replace(/-/g, "");

function esc(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds lines to at most 75 bytes (the iCalendar limit) without splitting a character. */
function fold(line: string) {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 74) {
      out.push(cur);
      cur = " ";
      bytes = 1;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join("\r\n");
}

interface Ev {
  uid: string;
  summary: string;
  description?: string;
  start: Date | string; // Date = timed, string (YYYY-MM-DD) = all-day
  end?: Date;
}

export function buildIcs(db: DB, tz: string): string {
  const today = localNow(tz).date;
  const tasks = new Map(listTasks(db).map((t) => [t.id, t] as [string, Task]));
  const events: Ev[] = [];
  const planned = new Set<string>();

  // Confirmed plans: the past week (history stays visible) plus today and tomorrow.
  for (let i = -7; i <= 1; i++) {
    const date = addDays(today, i);
    const plan: Plan | null = currentPlan(db, date);
    if (!plan) continue;
    for (const b of plan.blocks) {
      if (b.kind !== "focus" && b.kind !== "task") continue;
      const task = b.taskId ? tasks.get(b.taskId) : undefined;
      if (task) planned.add(`${date}|${task.id}`);
      const done = task?.status === "done";
      events.push({
        uid: `${date}-${b.id}@nikki`,
        summary: `${done ? "✓ " : ""}${b.kind === "focus" ? "Focus: " : ""}${task?.title ?? b.title}`,
        description: "Planned with Nikki.",
        start: localToUtc(date, b.start, tz),
        end: localToUtc(date, b.end, tz),
      });
    }
  }

  // Meetings you added in Nikki (calendar-synced ones are already in your calendar).
  const meetings: Meeting[] = listMeetingsBetween(db, addDays(today, -7), addDays(today, 30)).filter((m) => m.source !== "calendar");
  for (const m of meetings) {
    events.push({ uid: `${m.id}@nikki`, summary: m.title, description: "Added in Nikki.", start: localToUtc(m.date, m.start, tz), end: localToUtc(m.date, m.end, tz) });
  }

  // Tasks planned for a day (Week view) that aren't in a timed plan: all-day reminders.
  for (const t of tasks.values()) {
    if (!t.plannedDate || t.status === "done" || t.plannedDate < today || planned.has(`${t.plannedDate}|${t.id}`)) continue;
    events.push({ uid: `plan-${t.id}-${t.plannedDate}@nikki`, summary: `Nikki: ${t.title}`, description: "Planned for this day in Nikki.", start: t.plannedDate });
  }

  const now = stamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nikki//Plans//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Nikki",
    "X-WR-CALDESC:Your confirmed plans from Nikki",
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${now}`);
    if (typeof e.start === "string") {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(e.start)}`, `DTEND;VALUE=DATE:${dateOnly(addDays(e.start, 1))}`, "TRANSP:TRANSPARENT");
    } else {
      lines.push(`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end!)}`);
    }
    lines.push(`SUMMARY:${esc(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
