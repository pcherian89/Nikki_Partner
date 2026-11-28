import type { DB } from "../db.js";
import { currentPlan } from "../db.js";
import { addDays, localNow, weekdayOf } from "../time.js";
import { listSpaces } from "../system/spaces.js";
import { listGoogleAccounts, usableAccounts } from "./accounts.js";
import { eventsBetween, STALE_MS, syncGoogleCalendar, UNAVAILABLE_RETRY_MS } from "./calendarSync.js";
import { getFeeds } from "../calendar.js";
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
  | { kind: "clarify"; text: string }
  | { kind: "email"; query: string; label: string; limit: number }
  | { kind: "calendar"; from: string; to: string; label: string }
  | { kind: "next_event" }
  | { kind: "free"; date: string; start: string; end: string; label: string };

const ASK = /^(?:hey\s+nikki[,!]?\s+|nikki[,!]?\s+)?(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:show|find|search|list|get|check|look|pull up|bring up|open|give me|tell me|any|what|what's|whats|which|did|have|has|do i|are there|is there|is anything|latest|recent|unread|how many|who)\b/i;
const DOING = /^(?:please\s+)?(?:write|draft|reply|respond|send|forward|compose|email|mail|archive|delete|label|move|mark|schedule|add|create|book|set up|cancel|reschedule|block|plan|remind)\b/i;

const EMAIL_WORD = /\b(e-?mails?|mails?|inbox|gmail|messages? from)\b|\b(?:have i|did i|i)\s+(?:received|receive|get|got|gotten)\b|\banything new\b|\bnew messages?\b|\b(?:heard|anything) from\b|\b(?:sent|wrote|emailed|messaged) me\b/i;
const CAL_WORD = /\b(schedule|calendar|meetings?|events?|appointments?|agenda|calls?|busy|booked|happening|free|available|availability)\b|\bwhat(?:'s| is)? on\b|\bwhats on\b|\bmy day\b|\bplans? (?:for|today|tomorrow)\b/i;
const PRONOUN_PERSON = /^(?:this|that|the) (?:person|guy|lady|man|woman|sender|client|one)$|^(?:him|her|them|someone|somebody|anyone|they)$/i;
const ACCESS = /\b(what|which)\b.*\b(information|info|data|accounts?|things|stuff)\b.*\b(can|do|are)\s+you\b.*\b(access|see|read|have|connected)\b|\bwhat can you (see|access|read)\b|\bwhat('s| is) connected\b|\bshow me what (information |data )?you can access\b|\bwhich accounts\b/i;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function quote(s: string) {
  const t = s.trim().replace(/["“”]/g, "");
  return /\s/.test(t) ? `"${t}"` : t;
}

const STOP_TAIL = /\s+(?:today|yesterday|this week|last week|this month|recently|please|in my inbox|in gmail|from (?:this|last) week)\s*$/i;

/** Builds a Gmail search from plain words. Returns null when the text isn't an email lookup. */
export function emailIntent(text: string, today: string): Extract<Intent, { kind: "email" | "clarify" }> | null {
  const t = text.trim();
  if (!EMAIL_WORD.test(t) || DOING.test(t) || !(ASK.test(t) || /\?\s*$/.test(t))) return null;
  const parts: string[] = [];
  const said: string[] = [];
  const lower = t.toLowerCase();
  const fromM = /\b(?:from|by|sent by)\s+([\w.+-]+@[\w-]+(?:\.[\w-]+)+|[^?.,!]+?)(?=\s+(?:about|regarding|re|on|related|concerning|mentioning|this|last|today|yesterday|in|since|that|which|with|to)\b|[?.,!]|$)/i.exec(t);
  // "Did Ravi email me…", "Has Asha written to me…", "Anything Ravi sent me…"
  const byM = fromM ? null : /\b(?:did|has|have)\s+([\w.+-]+@[\w-]+(?:\.[\w-]+)+|[A-Za-z][\w'-]*(?:\s+[A-Z][\w'-]*)?)\s+(?:e-?mail(?:ed)?|mail(?:ed)?|messaged?|written|wrote|sent|replied|got back)\b(?:\s+(?:to\s+)?me)?/i.exec(t);
  const fromWho = fromM ?? (byM && !/^(i|you|we|anyone|anybody|someone|somebody|they|he|she|it)$/i.test(byM[1]) ? byM : null);
  if (fromWho && !/^(me|myself)$/i.test(fromWho[1].trim())) {
    const fromM = fromWho;
    const who = fromM[1].replace(/^(?:my)\s+/i, "").trim();
    if (PRONOUN_PERSON.test(who)) return { kind: "clarify", text: "Who do you mean? Tell me their name or email address, for example: “latest email from Asha”." };
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
  if (/\bnew\b/.test(lower) && !/\b(today|yesterday|week|month|days?)\b/.test(lower)) {
    parts.push("newer_than:1d");
    said.push("in the last day");
  }
  const n = /\b(?:latest|last|recent|top|first)\s+(\d{1,2})\b/i.exec(t);
  const single = /\b(?:the )?(?:latest|last|most recent|newest) (?:e-?mail|mail|message)\b(?! ?s)/i.test(t);
  const limit = n ? Math.max(1, Math.min(25, Number(n[1]))) : single ? 3 : 10;
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

const FREE = /\b(?:am i|are we|i'?m|is my (?:day|afternoon|morning|evening))\s+(?:free|available|busy|booked)\b|\bfree time\b|\bavailability\b|\bany (?:free|open) (?:time|slots?)\b|\bwhen (?:am i|are we) free\b/i;
const NEXT = /\bnext (?:meeting|call|event|appointment)\b|\bwhen(?:'s| is) my next\b|\bwhat(?:'s| is) next on my (?:calendar|schedule)\b/i;

/** "Am I free tomorrow afternoon?", "free at 3pm on Friday" -> a day and a time window. */
export function freeIntent(text: string, today: string, workStart = "09:00", workEnd = "18:00"): Extract<Intent, { kind: "free" }> | null {
  if (!FREE.test(text) || DOING.test(text)) return null;
  const day = calendarIntent(text.replace(FREE, "calendar").replace(/[?.!\s]*$/, "?"), today) ?? { kind: "calendar" as const, from: today, to: today, label: "Today" };
  const lower = text.toLowerCase();
  let start = workStart;
  let end = workEnd;
  let part = "";
  const at = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (at) {
    let h = Number(at[1]);
    const ap = at[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 7) h += 12; // "at 3" in a working day means 3 PM
    start = `${String(h).padStart(2, "0")}:${at[2] ?? "00"}`;
    end = `${String(Math.min(23, h + 1)).padStart(2, "0")}:${at[2] ?? "00"}`;
    part = ` at ${h12(start)}`;
  } else if (/\bmorning\b/.test(lower)) (start = "08:00", end = "12:00", part = " morning");
  else if (/\bafternoon\b/.test(lower)) (start = "12:00", end = "17:00", part = " afternoon");
  else if (/\bevening\b|\btonight\b/.test(lower)) (start = "17:00", end = "21:00", part = /tonight/.test(lower) ? " tonight" : " evening");
  return { kind: "free", date: day.from, start, end, label: `${day.label}${part}` };
}

export function detectIntent(text: string, today: string, opts: { workStart?: string; workEnd?: string } = {}): Intent | null {
  if (text.length > 300) return null;
  if (ACCESS.test(text)) return { kind: "access" };
  const email = emailIntent(text, today);
  if (email) return email;
  if (NEXT.test(text) && !DOING.test(text)) return { kind: "next_event" };
  const ok = (v?: string) => (v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined);
  const ws = ok(opts.workStart);
  const we = ok(opts.workEnd);
  const hours = ws && we && we > ws ? [ws, we] : [undefined, undefined];
  return freeIntent(text, today, hours[0], hours[1]) ?? calendarIntent(text, today);
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
          source: "Gmail · read-only · looked up directly, no AI",
        },
      },
    };
  }
  if (intent.kind === "clarify") return { text: intent.text, meta: { google: { kind: "notice" } } };
  // Calendar questions: answered from every calendar source Nikki has (Google Calendar, calendar links, meetings
  // added in Nikki), with each source's freshness and any source that isn't available right now.
  const cal = await calendarSources(db, tz);
  if (!cal.google) return null; // no Google calendar connected: the planner answers exactly as before
  const notes = cal.problems;
  if (intent.kind === "next_event") {
    const now = localNow(tz);
    const { timed } = eventsBetween(db, now.date, addDays(now.date, 14));
    const next = timed.find((m) => m.date > now.date || m.end > now.time);
    const item = next ? toItem(next, cal) : null;
    const when = item ? `${item.date === now.date ? "today" : item.date === addDays(now.date, 1) ? "tomorrow" : `on ${weekdayOf(item.date)} ${item.date.slice(8)}`} at ${h12(item.start)}` : "";
    const text = item
      ? `${item.start <= now.time && item.date === now.date ? "Happening now" : "Your next one is"}: ${item.title}, ${when} (until ${h12(item.end)}).`
      : "Nothing on your calendar in the next two weeks.";
    return { text: withNotes(text, notes), meta: { google: { kind: "calendar", from: now.date, to: addDays(now.date, 14), label: "Next", items: item ? [item] : [], allDay: [], planBlocks: [], sources: cal.sources, unavailable: notes, fetchedAt: new Date().toISOString(), source: "Your calendars · looked up directly, no AI", today } } };
  }
  if (intent.kind === "free") {
    const { timed, allDay } = eventsBetween(db, intent.date, intent.date);
    const now = localNow(tz);
    const busy: { start: string; end: string; title: string }[] = timed.map((m) => ({ start: m.start, end: m.end, title: m.title }));
    for (const b of currentPlan(db, intent.date)?.blocks ?? []) if (b.kind === "focus" || b.kind === "task") busy.push({ start: b.start, end: b.end, title: `${b.title} (your plan)` });
    let from = intent.start;
    if (intent.date === now.date && now.time > from) from = now.time;
    const clash = busy.filter((b) => b.end > from && b.start < intent.end).sort((a, b) => a.start.localeCompare(b.start));
    const gaps: string[] = [];
    let cursor = from;
    for (const b of clash) {
      if (b.start > cursor && toMin(b.start) - toMin(cursor) >= 15) gaps.push(`${h12(cursor)}–${h12(b.start)}`);
      if (b.end > cursor) cursor = b.end;
    }
    if (intent.end > cursor && toMin(intent.end) - toMin(cursor) >= 15) gaps.push(`${h12(cursor)}–${h12(intent.end)}`);
    let text: string;
    if (from >= intent.end) text = `That time has already passed today.`;
    else if (!clash.length) text = `Yes, ${intent.label.toLowerCase()} (${h12(from)}–${h12(intent.end)}) is free.`;
    else if (!gaps.length) text = `No, ${intent.label.toLowerCase()} is fully booked: ${clash.map((c) => `${h12(c.start)}–${h12(c.end)} ${c.title}`).join("; ")}.`;
    else text = `Partly. ${intent.label}: busy ${clash.map((c) => `${h12(c.start)}–${h12(c.end)} ${c.title}`).join("; ")}. Free ${gaps.join(", ")}.`;
    if (allDay.length) text += `\nAll day: ${allDay.map((a) => a.title).join(", ")}.`;
    return {
      text: withNotes(text, notes),
      meta: { google: { kind: "calendar", from: intent.date, to: intent.date, label: intent.label, items: timed.filter((m) => m.end > intent.start && m.start < intent.end).map((m) => toItem(m, cal)), allDay: allDay.map((a) => ({ id: a.id, date: a.date, title: a.title, link: a.link })), planBlocks: [], sources: cal.sources, unavailable: notes, fetchedAt: new Date().toISOString(), source: "Your calendars · looked up directly, no AI", today } },
    };
  }
  const { timed, allDay } = eventsBetween(db, intent.from, intent.to);
  const items = timed.map((m) => toItem(m, cal));
  const planBlocks: { date: string; start: string; end: string; title: string }[] = [];
  for (let d = intent.from; d <= intent.to; d = addDays(d, 1)) {
    const p = currentPlan(db, d);
    for (const b of p?.blocks ?? []) if (b.kind === "focus" || b.kind === "task") planBlocks.push({ date: d, start: b.start, end: b.end, title: b.title });
  }
  const oneDay = intent.from === intent.to;
  const when = oneDay ? (intent.label === "Today" ? "today" : intent.label === "Tomorrow" ? "tomorrow" : `on ${intent.label}`) : intent.label.toLowerCase();
  let text: string;
  if (!items.length && !allDay.length) text = `Nothing on your calendar ${when}.`;
  else {
    const lines = items.slice(0, 6).map((i) => `• ${oneDay ? "" : `${weekdayOf(i.date).slice(0, 3)} `}${h12(i.start)}–${h12(i.end)} ${i.title}`);
    text = `${items.length} event${items.length === 1 ? "" : "s"} ${when}${allDay.length ? ` plus ${allDay.length} all-day` : ""}:\n${lines.join("\n")}${items.length > 6 ? "\n…and more below." : ""}`;
  }
  return {
    text: withNotes(text, notes),
    meta: {
      google: {
        kind: "calendar",
        from: intent.from,
        to: intent.to,
        label: intent.label,
        items,
        allDay: allDay.map((a) => ({ id: a.id, date: a.date, title: a.title, link: a.link })),
        planBlocks: planBlocks.slice(0, 20),
        sources: cal.sources,
        unavailable: notes,
        fetchedAt: new Date().toISOString(),
        source: "Your calendars · looked up directly, no AI",
        today,
      },
    },
  };
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const withNotes = (text: string, notes: string[]) => (notes.length ? `${text}\n(${notes.join(" ")})` : text);

type Sources = Awaited<ReturnType<typeof calendarSources>>;

/** Labels an event by where it came from: the connected Google account, a calendar link, or Nikki itself. */
function toItem(m: ReturnType<typeof eventsBetween>["timed"][number], cal: Sources) {
  let source: string;
  if (m.feedId?.startsWith("google:")) {
    const email = cal.accountEmails.get(m.accountId ?? "") ?? "";
    source = `Google Calendar${m.calendarName && m.calendarId?.toLowerCase() !== email.toLowerCase() ? ` · ${m.calendarName}` : ""}`;
  } else if (m.source === "calendar") source = `Calendar link${cal.feedNames.get(m.feedId ?? "") ? ` (${cal.feedNames.get(m.feedId ?? "")})` : ""}`;
  else source = "Added in Nikki";
  return { id: m.id, date: m.date, title: m.title, start: m.start, end: m.end, source, link: m.link, location: m.location };
}

/** Every calendar source, refreshed if stale, with plain notes about any that can't be read right now. */
async function calendarSources(db: DB, tz: string) {
  const google = listGoogleAccounts(db).filter((a) => a.services.includes("calendar") || a.status === "needs_reconnect");
  const feeds = getFeeds(db);
  const problems: string[] = [];
  const sources: { label: string; updatedAt: string | null; ok: boolean }[] = [];
  for (const a of google) {
    if (a.status === "needs_reconnect") {
      problems.push(`Google Calendar for ${a.email} needs you to sign in again, so its events may be out of date.`);
      continue;
    }
    if (a.status !== "connected") continue;
    const unavailable = a.syncStatus === "unavailable";
    const retryAfter = unavailable ? UNAVAILABLE_RETRY_MS : STALE_MS;
    if (!a.lastSyncAt || Date.now() - Date.parse(a.lastSyncAt) > retryAfter) await syncGoogleCalendar(db, a.id, tz);
    const fresh = listGoogleAccounts(db).find((x) => x.id === a.id)!;
    const ok = fresh.syncStatus === "ok";
    sources.push({ label: `Google Calendar (${fresh.email})`, updatedAt: ok ? fresh.lastSyncAt : null, ok });
    if (!ok) problems.push(fresh.syncStatus === "unavailable" ? `Google Calendar isn't available for ${fresh.email} yet${feeds.length ? "; your calendar link is still used" : ""}.` : `Couldn't refresh Google Calendar just now: ${fresh.lastError ?? "unknown problem"}.`);
  }
  for (const f of feeds) {
    sources.push({ label: `Calendar link (${f.name})`, updatedAt: f.lastSyncAt, ok: !f.lastError });
    if (f.lastError) problems.push(`Calendar link “${f.name}” couldn't update: ${f.lastError}`);
  }
  const accountEmails = new Map(listGoogleAccounts(db).map((a) => [a.id, a.email ?? ""]));
  return { google: google.length > 0, sources, problems, accountEmails, feedNames: new Map(feeds.map((f) => [f.id, f.name])) };
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
