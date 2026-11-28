import { randomUUID } from "node:crypto";
import { clockIso, type DB } from "../db.js";
import { localNow } from "../time.js";
import { DAILY_CALL_LIMIT, endpoints } from "./config.js";

/**
 * A minimal client for Google's remote MCP servers (Streamable HTTP, JSON-RPC 2.0, OAuth bearer token).
 *
 * Safety rules, enforced here in code:
 * - Only the read tools in READ_TOOLS can ever be called. Anything else (send, reply, forward, trash, labels, filters,
 *   create/update/delete event) is refused before a request is made, whatever the model, the user's wording or the
 *   server's tool list says. Stage 1A has no way to change a mailbox or a calendar.
 * - Nikki never answers Google's approval forms (elicitation). If Google asks for one, the call stops.
 * - Every call is counted per day and product and stops at an internal ceiling (DAILY_CALL_LIMIT).
 * - Content that comes back is untrusted data (it was written by whoever sent the email). Callers never let it
 *   change instructions, settings or permissions.
 */

export type Product = "gmail" | "calendar";

export const READ_TOOLS: Record<Product, readonly string[]> = {
  gmail: ["search_threads", "get_thread", "get_message", "list_labels"],
  calendar: ["list_calendars", "list_events", "get_event", "search_events", "suggest_time"],
};

export const PROTOCOL_VERSION = "2026-07-28";

export class GoogleError extends Error {
  constructor(
    message: string,
    public code: "not_allowed" | "auth" | "forbidden" | "quota" | "limit" | "network" | "approval_needed" | "bad_response" | "server",
    public status = 502,
  ) {
    super(message);
  }
}

type FetchFn = typeof fetch;
let fetchImpl: FetchFn = (...a) => fetch(...a);
/** Tests replace the network with a fake Google. */
export const setGoogleFetch = (f: FetchFn | null) => (fetchImpl = f ?? ((...a) => fetch(...a)));
export const googleFetch: FetchFn = (...a) => fetchImpl(...a);

export function isAllowedTool(product: Product, tool: string) {
  return READ_TOOLS[product].includes(tool);
}

/** Counts a call; refuses once today's ceiling is reached. Days follow India time. */
function countCall(db: DB, product: Product, failed = false) {
  const day = localNow("Asia/Kolkata").date;
  const row = db.prepare("SELECT count FROM provider_calls WHERE day = ? AND product = ?").get(day, product) as { count: number } | undefined;
  if (!failed && (row?.count ?? 0) >= DAILY_CALL_LIMIT) {
    throw new GoogleError(`Nikki has reached its own daily limit for ${product === "gmail" ? "Gmail" : "Calendar"} (${DAILY_CALL_LIMIT} requests). It resets at midnight.`, "limit", 429);
  }
  db.prepare(
    `INSERT INTO provider_calls (day, product, count, errors, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, product) DO UPDATE SET count = count + excluded.count, errors = errors + excluded.errors, updated_at = excluded.updated_at`,
  ).run(day, product, failed ? 0 : 1, failed ? 1 : 0, clockIso());
}

export function callsToday(db: DB) {
  const day = localNow("Asia/Kolkata").date;
  const rows = db.prepare("SELECT product, count, errors FROM provider_calls WHERE day = ?").all(day) as { product: Product; count: number; errors: number }[];
  return { day, limit: DAILY_CALL_LIMIT, gmail: rows.find((r) => r.product === "gmail")?.count ?? 0, calendar: rows.find((r) => r.product === "calendar")?.count ?? 0 };
}

/** Reads a JSON or Server-Sent-Events reply and returns the JSON-RPC message with our id. */
async function readRpc(res: Response, id: string): Promise<Record<string, any>> {
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (type.includes("text/event-stream")) {
    let found: Record<string, any> | null = null;
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg && msg.id === id) found = msg;
      } catch {
        /* ignore keep-alives and partial events */
      }
    }
    if (!found) throw new GoogleError("Google's reply didn't include an answer.", "bad_response");
    return found;
  }
  try {
    const msg = JSON.parse(text);
    return Array.isArray(msg) ? msg.find((m) => m.id === id) ?? msg[0] : msg;
  } catch {
    throw new GoogleError(`Google answered in an unexpected format (HTTP ${res.status}).`, "bad_response");
  }
}

const sessions = new Map<string, string>(); // `${accountId}:${product}` -> Mcp-Session-Id, when a server uses them

function plainGoogleMessage(raw: unknown): string {
  const s = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  return s.replace(/\s+/g, " ").slice(0, 240);
}

interface CallOpts {
  db: DB;
  accountId: string;
  product: Product;
  tool: string;
  args: Record<string, unknown>;
  /** Returns a valid access token; `force` asks for a fresh one after a 401. */
  token: (force: boolean) => Promise<string>;
}

async function post(o: CallOpts, body: Record<string, unknown>, accessToken: string): Promise<Response> {
  const url = o.product === "gmail" ? endpoints().gmailMcp : endpoints().calendarMcp;
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  const sid = sessions.get(`${o.accountId}:${o.product}`);
  if (sid) headers["mcp-session-id"] = sid;
  try {
    return await googleFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new GoogleError((e as Error).name === "TimeoutError" ? "Google took too long to answer." : "Couldn't reach Google.", "network");
  }
}

/** Older servers want an initialize handshake first; do it once and remember the session id. */
async function initialize(o: CallOpts, accessToken: string) {
  const id = randomUUID();
  const res = await post(o, { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "Nikki", version: "1.0" } } }, accessToken);
  const sid = res.headers.get("mcp-session-id");
  await readRpc(res, id).catch(() => null);
  if (sid) sessions.set(`${o.accountId}:${o.product}`, sid);
  await post(o, { jsonrpc: "2.0", method: "notifications/initialized" }, accessToken).catch(() => null);
}

const needsHandshake = (status: number, msg: Record<string, any> | null) =>
  /session|initiali[sz]e/i.test(JSON.stringify(msg?.error ?? "")) || (status === 400 && !msg?.result);

/**
 * Calls one read tool and returns its structured result. Throws GoogleError with a plain message on any problem.
 */
export async function callReadTool(o: CallOpts): Promise<Record<string, any>> {
  if (!isAllowedTool(o.product, o.tool)) {
    throw new GoogleError(`Nikki can only read ${o.product === "gmail" ? "Gmail" : "Google Calendar"} at this stage; "${o.tool}" isn't allowed.`, "not_allowed", 403);
  }
  countCall(o.db, o.product);
  const id = randomUUID();
  // Declare no elicitation capability: Nikki never approves anything on Google's side.
  const body = { jsonrpc: "2.0", id, method: "tools/call", params: { name: o.tool, arguments: o.args } };
  let token = await o.token(false);
  const attempt = async () => {
    let res = await post(o, body, token);
    if (res.status === 401) {
      token = await o.token(true);
      res = await post(o, body, token);
    }
    const msg = [401, 403, 429].includes(res.status) ? null : await readRpc(res, id).catch(() => null);
    return { res, msg };
  };
  let { res, msg } = await attempt();
  if (![401, 403, 429].includes(res.status) && !msg?.result && needsHandshake(res.status, msg)) {
    await initialize(o, token);
    ({ res, msg } = await attempt());
  }
  if (res.status === 401) {
    countCall(o.db, o.product, true);
    throw new GoogleError("Google needs you to sign in again.", "auth", 401);
  }
  if (res.status === 403) {
    countCall(o.db, o.product, true);
    const detail = plainGoogleMessage(await res.text().catch(() => ""));
    throw new GoogleError(`Google refused the request. ${detail ? `Google said: ${detail}` : ""}`.trim(), "forbidden", 403);
  }
  if (res.status === 429) {
    countCall(o.db, o.product, true);
    throw new GoogleError("Google's limit for now has been reached. Try again in a few minutes.", "quota", 429);
  }
  if (!msg) {
    countCall(o.db, o.product, true);
    throw new GoogleError(`Google answered with an error (HTTP ${res.status}).`, "server");
  }
  if (msg.error) {
    countCall(o.db, o.product, true);
    const text = plainGoogleMessage(msg.error.message ?? msg.error);
    if (/MissingRequiredClientCapability|elicitation/i.test(text)) throw new GoogleError("Google asked for an approval step that reading never needs, so Nikki stopped.", "approval_needed", 409);
    throw new GoogleError(`Google couldn't do that: ${text}`, "server");
  }
  const result = msg.result ?? {};
  if (result.resultType === "input_required") {
    countCall(o.db, o.product, true);
    throw new GoogleError("Google asked for an approval before reading, so Nikki stopped and changed nothing.", "approval_needed", 409);
  }
  if (result.isError) {
    countCall(o.db, o.product, true);
    const text = (result.content ?? []).map((c: any) => c?.text ?? "").join(" ");
    throw new GoogleError(`Google couldn't do that: ${plainGoogleMessage(text) || "unknown error"}`, "server");
  }
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = (result.content ?? []).find((c: any) => c?.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
  return result;
}

export const forgetMcpSessions = (accountId: string) => {
  for (const k of [...sessions.keys()]) if (k.startsWith(`${accountId}:`)) sessions.delete(k);
};
