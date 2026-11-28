import type { DB } from "../db.js";
import { currentPlan } from "../db.js";
import { addDays, localNow, weekdayOf } from "../time.js";
import { listSpaces } from "../system/spaces.js";
import { listGoogleAccounts, usableAccounts } from "./accounts.js";
import { eventsBetween, STALE_MS, syncGoogleCalendar } from "./calendarSync.js";
import { searchEmail, type EmailSummary } from "./gmail.js";
import { GoogleError } from "./mcp.js";

/**
 * Email and calendar questions in the existing chat, answered by the app itself (no AI, no cost):
 *   "Show me my latest emails", "Find emails from Asha", "Emails about the venue contract",
 *   "What's my schedule today?", "Do I have any meetings tomorrow?", "What information can you access?"
 *
 * Detection is deliberately narrow: a request to look something up, never a request to do something. Anything else
 * ("email Asha about the invoice", "schedule a call", "plan my day") goes to the planner exactly as before.
 * Calendar questions are only answered here once a Google calendar is connected, so nothing changes until then.
 */

export type Intent =
  | { kind: "access" }
  | { kind: "email"; query: string; label: string; limit: number }
  | { kind: "calendar"; from: string; to: string; label: string };

const ASK = /^(?:hey\s+nikki[,!]?\s+|nikki[,!]?\s+)?(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:show|find|search|list|get|check|look|pull up|bring up|open|give me|tell me|any|what|what's|whats|which|did|have|has|do i|are there|is there|is anything|latest|recent|unread|how many|who)\b/i;
const DOING = /^(?:please\s+)?(?:write|draft|reply|respond|send|forward|compose|email|mail|archive|delete|label|move|mark|schedule|add|create|book|set up|cancel|reschedule|block|plan|remind)\b/i;

const EMAIL_WORD = /\b(e-?mails?|mails?|inbox|gmail|messages? from)\b/i;
const CAL_WORD = /\b(schedule|calendar|meetings?|events?|appointments?|agenda|calls?|busy|booked)\b/i;
const ACCESS = /\b(what|which)\b.*\b(information|info|data|accounts?|things|stuff)\b.*\b(can|do|are)\s+you\b.*\b(access|see|read|have|connected)\b|\bwhat can you (see|access|read)\b|\bwhat('s| is) connected\b|\bshow me what (information |data )?you can access\b|\bwhich accounts\b/i;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function quote(s: string) {
  const t = s.trim().replace(/["“”]/g, "");
  return /\s/.test(t) ? `"${t}"` : t;
}

const STOP_TAIL = /\s+(?:today|yesterday|this week|last week|this month|recently|please|in my inbox|in gmail|from (?:this|last) week)\s*$/i;

/** Builds a Gmail search from plain words. Returns null when the text isn't an email lookup. */
export function emailIntent(text: string, today: string): Extract<Intent, { kind: "email" }> | null {
  const t = text.trim();
  if (!EMAIL_WORD.test(t) || DOING.test(t) || !(ASK.test(t) || /\?\s*$/.test(t))) return null;
  const parts: string[] = [];
  const said: string[] = [];
  const lower = t.toLowerCase();
  const fromM = /\b(?:from|by|sent by)\s+([^?.,!]+?)(?=\s+(?:about|regarding|re|on|related|concerning|mentioning|this|last|today|yesterday|in|since|that|which|with|to)\b|[?.,!]|$)/i.exec(t);
  if (fromM && !/^(me|myself)$/i.test(fromM[1].trim())) {
    const who = fromM[1].replace(/^(?:my|the)\s+/i, "").trim();
    if (who) {
      parts.push(`from:${quote(who)}`);
      said.push(`from ${who}`);
    }
  }
  const toM = /\b(?:i sent|sent)\s+to\s+([^?.,!]+?)(?=\s+(?:about|regarding|on|this|last|today|yesterday)\b|[?.,!]|$)/i.exec(t);
  if (toM) {
    parts.push("in:sent", `to:${quote(toM[1])}`);
    said.push(`you sent to ${toM[1].trim()}`);
  } else if (/\b(?:i sent|my sent|sent mail|sent emails?)\b/i.test(t)) {
    parts.push("in:sent");
    said.push("you sent");
  }
  const aboutM = /\b(?:about|regarding|related to|relating to|on the subject of|concerning|mentioning|subject)\s+(.+?)(?=[?.!]|$)/i.exec(t);
  if (aboutM) {
    const topic = aboutM[1].replace(STOP_TAIL, "").replace(/^(?:the|my)\s+/i, "").trim();
    if (topic) {
      parts.push(quote(topic));
      said.push(`about “${topic}”`);
    }
  }
  if (/\bunread\b/.test(lower)) (parts.push("is:unread"), said.unshift("unread"));
  if (/\bimportant\b/.test(lower)) (parts.push("is:important"), said.unshift("important"));
  if (/\bstarred\b/.test(lower)) (parts.push("is:starred"), said.unshift("starred"));
  if (/\battachments?\b/.test(lower)) (parts.push("has:attachment"), said.push("with attachments"));
  const ymd = (d: string) => d.replace(/-/g, "/");
  if (/\btoday\b/.test(lower)) (parts.push(`after:${ymd(today)}`), said.push("today"));
  else if (/\byesterday\b/.test(lower)) (parts.push(`after:${ymd(addDays(today, -1))}`, `before:${ymd(today)}`), said.push("yesterday"));
  else if (/\b(this|past|last) week\b/.test(lower)) (parts.push("newer_than:7d"), said.push("in the last 7 days"));
  else if (/\b(this|past|last) month\b/.test(lower)) (parts.push("newer_than:30d"), said.push("in the last 30 days"));
  else {
    const days = /\b(?:last|past)\s+(\d{1,3})\s+days?\b/i.exec(t);
    if (days) (parts.push(`newer_than:${days[1]}d`), said.push(`in the last ${days[1]} days`));
  }
  const n = /\b(?:latest|last|recent|top|first)\s+(\d{1,2})\b/i.exec(t);
  const limit = n ? Math.max(1, Math.min(25, Number(n[1]))) : 10;
  if (!parts.length || parts.every((p) => /^(is:|newer_than|after:|before:|has:)/.test(p))) parts.unshift("in:inbox");
  const label = said.length ? `Emails ${said.join(", ")}` : "Your latest emails";
  return { kind: "email", query: parts.join(" "), label, limit };
}

/** Works out which day(s) a calendar question is about. */
export function calendarIntent(text: string, today: string): Extract<Intent, { kind: "calendar" }> | null {
  const t = text.trim();
  if (!CAL_WORD.test(t) || DOING.test(t) || !(ASK.test(t) || /\?\s*$/.test(t))) return null;
  if (EMAIL_WORD.test(t)) return null;
  const lower = t.toLowerCase();
  const wd = weekdayOf(today).toLowerCase();
  const day = (d: string, label: string) => ({ kind: "calendar" as const, from: d, to: d, label });
  if (/\bday after tomorrow\b/.test(lower)) return day(addDays(today, 2), "The day after tomorrow");
  if (/\btomorrow\b/.test(lower)) return day(addDays(today, 1), "Tomorrow");
  if (/\bnext week\b/.test(lower)) {
    const toMon = (8 - WEEKDAYS.indexOf(wd)) % 7 || 7;
    const mon = addDays(today, toMon);
    return { kind: "calendar", from: mon, to: addDays(mon, 6), label: "Next week" };
  }
  if (/\bthis week\b|\brest of the week\b/.test(lower)) {
    const toSun = (7 - WEEKDAYS.indexOf(wd)) % 7;
    return { kind: "calendar", from: today, to: addDays(today, toSun), label: "This week" };
  }
  for (let i = 0; i < 7; i++) {
    const name = WEEKDAYS[i];
    if (new RegExp(`\\b${name}\\b`).test(lower)) {
      let diff = (i - WEEKDAYS.indexOf(wd) + 7) % 7;
      if (diff === 0 && new RegExp(`\\bnext ${name}\\b`).test(lower)) diff = 7;
      const d = addDays(today, diff);
      return day(d, diff === 0 ? "Today" : name[0].toUpperCase() + name.slice(1));
    }
  }
  return day(today, "Today");
}

export function detectIntent(text: string, today: string): Intent | null {
  if (text.length > 300) return null;
  if (ACCESS.test(text)) return { kind: "access" };
  return emailIntent(text, today) ?? calendarIntent(text, today);
}

export interface ChatAnswer {
  text: string;
  meta: Record<string, unknown>;
}

/** "15:00" -> "3:00 PM", matching the rest of the app. */
export const h12 = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

const fmtWhen = (iso: string | null, tz: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
};

/** Answers an intent, or returns null to let the planner handle the message as before. */
export async function answerIntent(db: DB, intent: Intent, tz: string): Promise<ChatAnswer | null> {
  const today = localNow(tz).date;
  if (intent.kind === "access") return accessAnswer(db);
  if (intent.kind === "email") {
    const accounts = usableAccounts(db, "gmail");
    if (!accounts.length) {
      const waiting = listGoogleAccounts(db).find((a) => a.status === "needs_reconnect");
      return {
        text: waiting ? `Google needs you to sign in again before I can read ${waiting.email}. Open Context → Accounts and tap Reconnect.` : "Gmail isn't connected yet, so I can't look at your email. You can connect it in Context → Accounts.",
        meta: { google: { kind: "notice", link: "/?view=context#accounts" } },
      };
    }
    const results: EmailSummary[] = [];
    const errors: string[] = [];
    let more = false;
    let searchUrl = "";
    for (const a of accounts.slice(0, 3)) {
      try {
        const r = await searchEmail(db, { accountId: a.id, query: intent.query, limit: intent.limit });
        results.push(...r.threads);
        more ||= r.more;
        searchUrl ||= r.gmailSearchUrl;
      } catch (e) {
        errors.push(`${a.email}: ${(e as Error).message}`);
      }
    }
    results.sort((x, y) => (Date.parse(y.date ?? "") || 0) - (Date.parse(x.date ?? "") || 0));
    const items = results.slice(0, intent.limit).map((r) => ({
      accountId: r.accountId,
      accountEmail: r.accountEmail,
      threadId: r.threadId,
      subject: r.subject,
      sender: r.sender,
      senderEmail: r.senderEmail,
      date: r.date,
      unread: r.unread,
      important: r.important,
      messageCount: r.messageCount,
      link: r.link,
      flagged: r.flagged.length > 0,
    }));
    const where = accounts.length === 1 ? ` (${accounts[0].email})` : "";
    let text: string;
    if (errors.length && !items.length) text = `I couldn't search Gmail just now. ${errors[0]}`;
    else if (!items.length) text = `I didn't find any emails for that${where}. I searched Gmail for: ${intent.query}`;
    else {
      const top = items.slice(0, 3).map((i) => `• ${i.sender}: “${i.subject}”${i.date ? ` (${fmtWhen(i.date, tz)})` : ""}`).join("\n");
      text = `${intent.label}${where}: ${items.length}${more ? "+" : ""} conversation${items.length === 1 ? "" : "s"}.\n${top}${items.length > 3 ? "\n…and more below." : ""}`;
    }
    if (errors.length && items.length) text += `\n(Couldn't reach ${errors.length} account${errors.length === 1 ? "" : "s"}.)`;
    return {
      text,
      meta: {
        google: {
          kind: "email",
          accountId: accounts.length === 1 ? accounts[0].id : undefined,
          accountIds: accounts.slice(0, 3).map((a) => a.id),
          query: intent.query,
          label: intent.label,
          items,
          more,
          gmailSearchUrl: searchUrl,
          fetchedAt: new Date().toISOString(),
          source: "Gmail · read-only",
        },
      },
    };
  }
  // calendar
  const cals = usableAccounts(db, "calendar");
  if (!cals.length) return null; // unchanged behaviour until Google Calendar is connected
  const syncErrors: string[] = [];
  for (const a of cals) {
    if (!a.lastSyncAt || Date.now() - Date.parse(a.lastSyncAt) > STALE_MS) {
      const r = await syncGoogleCalendar(db, a.id, tz);
      if (!r.ok && r.error) syncErrors.push(`${a.email}: ${r.error}`);
    }
  }
  const { timed, allDay } = eventsBetween(db, intent.from, intent.to);
  const accounts = new Map(listGoogleAccounts(db).map((a) => [a.id, a.email]));
  const sourceOf = (m: { source: string; feedId: string | null; accountId: string | null; calendarName: string | null; calendarId: string | null }) =>
    m.feedId?.startsWith("google:")
      ? `Google Calendar${m.calendarName && m.calendarId?.toLowerCase() !== (accounts.get(m.accountId ?? "") ?? "").toLowerCase() ? ` · ${m.calendarName}` : ""}`
      : m.source === "calendar"
        ? "Calendar link"
        : "Added in Nikki";
  const items = timed.map((m) => ({ id: m.id, date: m.date, title: m.title, start: m.start, end: m.end, source: sourceOf(m), link: m.link, location: m.location }));
  const planBlocks: { date: string; start: string; end: string; title: string }[] = [];
  for (let d = intent.from; d <= intent.to; d = addDays(d, 1)) {
    const p = currentPlan(db, d);
    for (const b of p?.blocks ?? []) if (b.kind === "focus" || b.kind === "task") planBlocks.push({ date: d, start: b.start, end: b.end, title: b.title });
  }
  const oneDay = intent.from === intent.to;
  const when = oneDay ? (intent.label === "Today" ? "today" : intent.label === "Tomorrow" ? "tomorrow" : `on ${intent.label}`) : intent.label.toLowerCase();
  const lastSync = cals.map((a) => a.lastSyncAt).filter(Boolean).sort().reverse()[0] ?? null;
  let text: string;
  if (!items.length && !allDay.length) text = `Nothing on your calendar ${when}.`;
  else {
    const lines = items.slice(0, 6).map((i) => `• ${oneDay ? "" : `${weekdayOf(i.date).slice(0, 3)} `}${h12(i.start)}–${h12(i.end)} ${i.title}`);
    text = `${items.length} event${items.length === 1 ? "" : "s"} ${when}${allDay.length ? ` plus ${allDay.length} all-day` : ""}:\n${lines.join("\n")}${items.length > 6 ? "\n…and more below." : ""}`;
  }
  if (syncErrors.length) text += `\n(Couldn't refresh from Google just now, so this may be out of date: ${syncErrors[0]})`;
  return {
    text,
    meta: {
      google: {
        kind: "calendar",
        from: intent.from,
        to: intent.to,
        label: intent.label,
        items,
        allDay: allDay.map((a) => ({ id: a.id, date: a.date, title: a.title, link: a.link })),
        planBlocks: planBlocks.slice(0, 20),
        lastSyncAt: lastSync,
        fetchedAt: new Date().toISOString(),
        source: "Your calendars · read-only",
        today,
      },
    },
  };
}

function accessAnswer(db: DB): ChatAnswer {
  const accounts = listGoogleAccounts(db).filter((a) => a.status !== "revoked");
  const spaces = new Map(listSpaces(db).map((s) => [s.id, s.name]));
  const lines = accounts.length
    ? accounts.map((a) => {
        const what = a.services.map((s) => (s === "gmail" ? "read and search Gmail" : "read Google Calendar")).join(" and ");
        const status = a.status === "connected" ? `I can ${what || "nothing yet"}` : a.status === "needs_reconnect" ? "needs you to sign in again" : "not connected";
        return `• ${a.email ?? a.label} (${spaces.get(a.spaceId) ?? a.spaceId}): ${status}.`;
      })
    : ["• No Google account is connected yet."];
  const text = [
    "Here's what I can access:",
    "• Everything you've told me in Nikki: tasks, plans, projects, goals, reminders and notes.",
    ...lines,
    "I can't send, reply, delete, archive, label or mark email as read, and I can't change your calendar. Agents can't use your Google accounts.",
  ].join("\n");
  return { text, meta: { google: { kind: "access", accounts: accounts.map((a) => ({ id: a.id, email: a.email, status: a.status, services: a.services, space: spaces.get(a.spaceId) ?? a.spaceId, lastSyncAt: a.lastSyncAt })), link: "/?view=context#accounts" } } };
}

export const isGoogleError = (e: unknown): e is GoogleError => e instanceof GoogleError;
