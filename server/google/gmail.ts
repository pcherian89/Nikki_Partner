import type { DB } from "../db.js";
import { UserFacingError } from "../errors.js";
import { requireSpace } from "../system/spaces.js";
import { accessToken, googleAccount, markNeedsReconnect, usableAccounts, type GoogleAccount } from "./accounts.js";
import { callReadTool, GoogleError } from "./mcp.js";

/**
 * Gmail, read-only. Nikki searches and opens conversations on request and does not keep a copy of the mailbox:
 * results are fetched live, held in memory for two minutes to avoid repeat requests, and shown. Nothing is marked
 * read, archived, deleted, labelled or moved (the tools that could are never called; see mcp.ts).
 *
 * Email content is untrusted: it is shown as plain text and never treated as an instruction.
 */

export interface EmailSummary {
  accountId: string;
  accountEmail: string | null;
  threadId: string;
  messageCount: number;
  subject: string;
  sender: string;
  senderEmail: string | null;
  to: string[];
  date: string | null;
  snippet: string;
  unread: boolean;
  important: boolean;
  starred: boolean;
  inInbox: boolean;
  category: string | null;
  link: string;
  flagged: string[];
}

export interface EmailMessage {
  id: string;
  sender: string;
  senderEmail: string | null;
  to: string[];
  cc: string[];
  date: string | null;
  subject: string;
  body: string;
  attachments: { filename: string; mimeType: string }[];
  unread: boolean;
  link: string;
}

const call = (db: DB, acc: GoogleAccount, tool: string, args: Record<string, unknown>) =>
  callReadTool({ db, accountId: acc.id, product: "gmail", tool, args, token: (force) => accessToken(db, acc.id, force) }).catch(async (e) => {
    if (e instanceof GoogleError && e.code === "auth") await markNeedsReconnect(db, acc.id, e.message);
    throw e;
  });

/** Gmail's own web link for a conversation, for the right account. Used when Google doesn't send one. */
export function gmailLink(email: string | null, threadId: string) {
  return `https://mail.google.com/mail/u/${encodeURIComponent(email ?? "0")}/#all/${encodeURIComponent(threadId)}`;
}
export function gmailSearchLink(email: string | null, query: string) {
  return `https://mail.google.com/mail/u/${encodeURIComponent(email ?? "0")}/#search/${encodeURIComponent(query)}`;
}
const safeGmailLink = (u: unknown, fallback: string) => {
  try {
    const url = new URL(String(u));
    return url.protocol === "https:" && url.hostname === "mail.google.com" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
};

/** "Asha Rao <asha@x.com>" -> name and email. */
export function parseAddress(raw: unknown): { name: string; email: string | null } {
  const s = String(raw ?? "").trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return { name: s, email: s.toLowerCase() };
  return { name: s || "Unknown sender", email: null };
}

const clean = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "").slice(0, n);

function summarise(acc: GoogleAccount, t: Record<string, any>, filteredIds: Set<string>): EmailSummary | null {
  const id = String(t?.id ?? "");
  if (!id) return null;
  const msgs = (Array.isArray(t.messages) ? t.messages : []) as Record<string, any>[];
  const last = msgs[msgs.length - 1] ?? {};
  const first = msgs[0] ?? {};
  const labels = new Set<string>(msgs.flatMap((m) => (Array.isArray(m.labelIds) ? m.labelIds : [])));
  const from = parseAddress(last.sender ?? first.sender);
  const category = [...labels].find((l) => l.startsWith("CATEGORY_"))?.slice(9).toLowerCase() ?? null;
  return {
    accountId: acc.id,
    accountEmail: acc.email,
    threadId: id,
    messageCount: Number(t.messageCount ?? msgs.length) || msgs.length,
    subject: clean(first.subject ?? last.subject, 200) || "(no subject)",
    sender: clean(from.name, 120),
    senderEmail: from.email,
    to: ((last.toRecipients ?? []) as unknown[]).slice(0, 5).map((r) => clean(r, 120)),
    date: last.date ?? first.date ?? null,
    snippet: filteredIds.has(id) ? "" : clean(last.snippet ?? first.snippet, 220),
    unread: labels.has("UNREAD"),
    important: labels.has("IMPORTANT"),
    starred: labels.has("STARRED"),
    inInbox: labels.has("INBOX"),
    category,
    link: safeGmailLink(t.viewUrl ?? last.viewUrl, gmailLink(acc.email, id)),
    flagged: filteredIds.has(id) ? ["Google flagged this conversation as possibly unsafe, so its preview is hidden."] : [],
  };
}

const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_MS = 2 * 60_000;
function cached<T>(key: string, fn: () => Promise<T>, fresh = false): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.value as T);
  return fn().then((v) => {
    cache.set(key, { at: Date.now(), value: v });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return v;
  });
}
export const forgetGmailCache = (accountId?: string) => {
  for (const k of [...cache.keys()]) if (!accountId || k.startsWith(`${accountId}|`)) cache.delete(k);
};

function pickAccount(db: DB, accountId?: string): GoogleAccount {
  if (accountId) {
    const a = googleAccount(db, accountId);
    if (!a) throw new UserFacingError("That account doesn't exist.", 404, "not_found");
    requireSpace(db, a.spaceId);
    if (a.status === "needs_reconnect") throw new UserFacingError(`Google needs you to sign in again for ${a.email}.`, 409, "needs_reconnect");
    if (a.status !== "connected" || !a.services.includes("gmail")) throw new UserFacingError("Gmail isn't connected for that account.", 409, "gmail_not_connected");
    return a;
  }
  const list = usableAccounts(db, "gmail");
  if (!list.length) throw new UserFacingError("Gmail isn't connected yet. Connect it in Context → Accounts.", 409, "gmail_not_connected");
  return list[0];
}

export interface SearchResult {
  account: { id: string; email: string | null };
  query: string;
  threads: EmailSummary[];
  more: boolean;
  estimate: number | null;
  fetchedAt: string;
  gmailSearchUrl: string;
}

/** Searches one account's mail with Gmail's own search syntax. Drafts are not included (Google leaves them out). */
export async function searchEmail(db: DB, opts: { accountId?: string; query: string; limit?: number; fresh?: boolean }): Promise<SearchResult> {
  const acc = pickAccount(db, opts.accountId);
  const query = clean(opts.query, 400).trim() || "in:inbox";
  const limit = Math.max(1, Math.min(50, opts.limit ?? 15));
  return cached(
    `${acc.id}|s|${query}|${limit}`,
    async () => {
      const r = await call(db, acc, "search_threads", { query, pageSize: limit });
      const filtered = new Set<string>(((r.filtered ?? r.omittedContent ?? []) as any[]).flatMap((f) => (typeof f === "object" && f ? [String(f.threadId ?? f.id ?? "")] : [])).filter(Boolean));
      const threads = ((r.threads ?? []) as Record<string, any>[]).map((t) => summarise(acc, t, filtered)).filter((t): t is EmailSummary => !!t);
      return { account: { id: acc.id, email: acc.email }, query, threads, more: !!r.nextPageToken, estimate: typeof r.resultCountEstimate === "number" ? r.resultCountEstimate : null, fetchedAt: new Date().toISOString(), gmailSearchUrl: gmailSearchLink(acc.email, query) };
    },
    opts.fresh,
  );
}

/** Opens a conversation as plain text. */
export async function getConversation(db: DB, accountId: string, threadId: string) {
  const acc = pickAccount(db, accountId);
  if (!/^[\w-]{6,64}$/.test(threadId)) throw new UserFacingError("That conversation id isn't valid.", 400, "invalid");
  return cached(`${acc.id}|t|${threadId}`, async () => {
    const t = await call(db, acc, "get_thread", { threadId, messageFormat: "PLAIN_TEXT" });
    const msgs = ((t.messages ?? []) as Record<string, any>[]).map((m): EmailMessage => {
      const from = parseAddress(m.sender);
      const labels = new Set<string>(Array.isArray(m.labelIds) ? m.labelIds : []);
      return {
        id: String(m.id ?? ""),
        sender: clean(from.name, 120),
        senderEmail: from.email,
        to: ((m.toRecipients ?? []) as unknown[]).slice(0, 20).map((r) => clean(r, 160)),
        cc: ((m.ccRecipients ?? []) as unknown[]).slice(0, 20).map((r) => clean(r, 160)),
        date: m.date ?? null,
        subject: clean(m.subject, 300) || "(no subject)",
        body: clean(m.plaintextBody ?? m.snippet, 60_000),
        attachments: ((m.attachments ?? []) as Record<string, any>[]).slice(0, 20).map((a) => ({ filename: clean(a.filename, 160) || "attachment", mimeType: clean(a.mimeType, 80) })),
        unread: labels.has("UNREAD"),
        link: safeGmailLink(m.viewUrl, gmailLink(acc.email, threadId)),
      };
    });
    return {
      account: { id: acc.id, email: acc.email },
      threadId,
      subject: msgs[0]?.subject ?? "(no subject)",
      messages: msgs,
      link: safeGmailLink(t.viewUrl, gmailLink(acc.email, threadId)),
      fetchedAt: new Date().toISOString(),
    };
  });
}

/** A quick health check used after connecting (cheapest read call). */
export async function checkGmail(db: DB, accountId: string) {
  const acc = pickAccount(db, accountId);
  const r = await call(db, acc, "list_labels", {});
  const inbox = ((r.labels ?? []) as Record<string, any>[]).find((l) => l.labelId === "INBOX" || l.id === "INBOX");
  return { unreadInInbox: typeof inbox?.threadsUnread === "number" ? inbox.threadsUnread : null };
}
