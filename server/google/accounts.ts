import { createHash, randomBytes } from "node:crypto";
import { clockIso, newId, type DB } from "../db.js";
import { UserFacingError } from "../errors.js";
import { currentInstant } from "../time.js";
import { deleteSecret, getSecret, putSecret, SecretUnavailableError } from "../security/secrets.js";
import { logActivity } from "../system/activity.js";
import { notify } from "../system/notifications.js";
import { getAccount, requireSpace, type ConnectedAccount } from "../system/spaces.js";
import { endpoints, GOOGLE_SCOPES, googleSetup, SCOPE_CALENDAR_READ, SCOPE_GMAIL_READ } from "./config.js";
import { forgetMcpSessions, googleFetch, GoogleError } from "./mcp.js";
import { recoveryStatus } from "./recovery.js";

/**
 * Google accounts: connect (OAuth with PKCE), identity check, encrypted refresh token, access-token refresh,
 * reconnect and disconnect. The account row lives in connected_accounts (system/spaces.ts); this file adds the
 * Google specifics. Many accounts are supported; each belongs to one space.
 *
 * What is stored: the refresh token (sealed with the server key, row-bound), the account's email, name and Google id,
 * the granted scopes, which calendars to read, and sync status. Access tokens live in memory only (one hour).
 * Disconnecting revokes the token at Google, deletes it here, and removes Nikki's copies of Google data
 * (calendar events and email results in chat). The user's own Nikki records stay.
 */

export type Service = "gmail" | "calendar";

export interface GoogleAccount extends ConnectedAccount {
  email: string | null;
  displayName: string | null;
  accountType: string | null;
  services: Service[];
  agentAccess: "none";
  calendars: { id: string; name: string; selected: boolean; primary?: boolean; skippedReason?: string }[];
  syncStatus: string | null;
  lastSyncAt: string | null;
  connectedAt: string | null;
}

type Extra = {
  email: string | null;
  display_name: string | null;
  account_type: string | null;
  google_sub: string | null;
  services: string;
  agent_access: string;
  calendars: string;
  sync_status: string | null;
  last_sync_at: string | null;
  connected_at: string | null;
};

const parse = <T,>(s: string | null | undefined, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
};

export function googleAccount(db: DB, id: string): GoogleAccount | null {
  const base = getAccount(db, id);
  if (!base || !base.provider.startsWith("google")) return null;
  const r = db.prepare("SELECT email, display_name, account_type, google_sub, services, agent_access, calendars, sync_status, last_sync_at, connected_at FROM connected_accounts WHERE id = ?").get(id) as Extra;
  return {
    ...base,
    email: r.email,
    displayName: r.display_name,
    accountType: r.account_type,
    services: parse<Service[]>(r.services, []),
    agentAccess: "none",
    calendars: parse(r.calendars, []),
    syncStatus: r.sync_status,
    lastSyncAt: r.last_sync_at,
    connectedAt: r.connected_at,
  };
}

export function listGoogleAccounts(db: DB): GoogleAccount[] {
  const ids = db.prepare("SELECT id FROM connected_accounts WHERE provider LIKE 'google%' ORDER BY created_at").all() as { id: string }[];
  return ids.map((r) => googleAccount(db, r.id)!).filter(Boolean);
}

/** Accounts that can be read right now for a service. */
export const usableAccounts = (db: DB, service: Service) =>
  listGoogleAccounts(db).filter((a) => a.status === "connected" && a.services.includes(service) && (() => {
    try {
      requireSpace(db, a.spaceId, { forAi: false });
      return true;
    } catch {
      return false;
    }
  })());

const normEmail = (e: string) => e.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- connect ----------

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");
const STATE_TTL_MS = 10 * 60_000;

/**
 * Starts a sign-in with Google. Creates the account record when new (status "not_connected"), stores a single-use
 * state bound to this device session, and returns Google's consent address.
 */
export function startConnect(
  db: DB,
  input: { accountId?: string; spaceId?: string; expectedEmail?: string; label?: string },
  sessionId: string | null,
): { url: string; accountId: string } {
  const setup = googleSetup();
  if (!setup.configured) throw new UserFacingError("Google sign-in isn't set up on the server yet.", 409, "google_not_configured", setup.problems);
  const rec = recoveryStatus(db);
  if (!rec.ready) throw new UserFacingError("Finish the safety checks first.", 409, "recovery_not_ready", rec.missing);

  let accountId = input.accountId;
  if (accountId) {
    const a = googleAccount(db, accountId);
    if (!a) throw new UserFacingError("That account doesn't exist.", 404, "not_found");
    requireSpace(db, a.spaceId);
  } else {
    const email = normEmail(input.expectedEmail ?? "");
    if (!EMAIL_RE.test(email)) throw new UserFacingError("Enter the Gmail address you're connecting, so Nikki can check it's the right account.", 400, "email_required");
    if (!/@(gmail|googlemail)\.com$/.test(email)) {
      throw new UserFacingError("Only personal Gmail accounts (ending in @gmail.com) can be connected at this stage. Work, school and government accounts come later, with their organisation's approval.", 400, "personal_only");
    }
    const space = requireSpace(db, input.spaceId ?? "personal");
    if (space.confidential) throw new UserFacingError("Confidential government accounts can't be connected.", 403, "confidential_space");
    const dup = listGoogleAccounts(db).find((a) => a.email && normEmail(a.email) === email && a.status !== "revoked");
    if (dup) throw new UserFacingError(`${email} is already in your accounts. Use Reconnect on it instead.`, 409, "duplicate_account");
    accountId = newId("acct");
    const now = clockIso();
    db.prepare(
      "INSERT INTO connected_accounts (id, provider, label, account_hint, space_id, status, scopes, created_at, updated_at, email, account_type, services) VALUES (?, 'google_personal', ?, ?, ?, 'not_connected', '[]', ?, ?, ?, 'personal', '[]')",
    ).run(accountId, (input.label?.trim() || email).slice(0, 80), email, space.id, now, now, email);
    logActivity(db, "user", "account.added", accountId, { kind: "google_personal" }, space.id);
  }

  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(new Date(currentInstant().getTime() - STATE_TTL_MS * 6).toISOString());
  let sealedVerifier: string;
  try {
    putSecret(db, `oauth_verifier:${hash(state)}`, verifier, "credential");
    sealedVerifier = "secret";
  } catch (e) {
    if (e instanceof SecretUnavailableError) throw new UserFacingError(e.message, 409, "no_encryption_key");
    throw e;
  }
  db.prepare("INSERT INTO oauth_states (state_hash, account_id, session_id, verifier, created_at) VALUES (?, ?, ?, ?, ?)").run(hash(state), accountId, sessionId, sealedVerifier, clockIso());

  const acc = googleAccount(db, accountId)!;
  const params = new URLSearchParams({
    client_id: setup.clientId,
    redirect_uri: setup.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "false",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (acc.email) params.set("login_hint", acc.email);
  logActivity(db, "user", "account.connect_started", accountId, {}, acc.spaceId);
  return { url: `${endpoints().authorize}?${params}`, accountId };
}

function decodeIdToken(idToken: string): Record<string, any> {
  // The token came straight from Google's token endpoint over TLS, so its claims can be read without re-checking
  // the signature (OpenID Connect Core 3.1.3.7). It is never accepted from the browser.
  const part = idToken.split(".")[1];
  if (!part) throw new GoogleError("Google didn't confirm which account signed in.", "bad_response");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

async function revokeAtGoogle(token: string) {
  try {
    await googleFetch(endpoints().revoke, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(10_000) });
    return true;
  } catch {
    return false;
  }
}

export type CallbackResult = { ok: true; accountId: string } | { ok: false; reason: string; message: string; accountId?: string };

function sessionStillValid(db: DB, sessionId: string | null) {
  if (!sessionId) return true; // local mode (no password)
  const r = db.prepare("SELECT revoked_at, expires_at, absolute_expires_at FROM auth_sessions WHERE id = ?").get(sessionId) as { revoked_at: string | null; expires_at: string; absolute_expires_at: string } | undefined;
  const now = currentInstant().getTime();
  return !!r && !r.revoked_at && Date.parse(r.expires_at) > now && Date.parse(r.absolute_expires_at) > now;
}

/** Handles Google's redirect back. Every failure leaves nothing stored and says why in plain words. */
export async function finishConnect(db: DB, q: { code?: string; state?: string; error?: string }): Promise<CallbackResult> {
  if (!q.state) return { ok: false, reason: "no_state", message: "The sign-in link was incomplete. Start again from Nikki." };
  const h = hash(q.state);
  const row = db.prepare("SELECT * FROM oauth_states WHERE state_hash = ?").get(h) as { account_id: string; session_id: string | null; created_at: string; used_at: string | null } | undefined;
  if (!row) return { ok: false, reason: "unknown_state", message: "That sign-in wasn't started from this Nikki. Start again from Nikki." };
  // Single use: mark it used before anything else.
  const claimed = db.prepare("UPDATE oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL").run(clockIso(), h).changes === 1;
  const verifier = getSecret(db, `oauth_verifier:${h}`);
  deleteSecret(db, `oauth_verifier:${h}`);
  const accountId = row.account_id;
  const fail = (reason: string, message: string): CallbackResult => {
    logActivity(db, "system", "account.connect_failed", accountId, { reason });
    db.prepare("UPDATE connected_accounts SET last_error = ?, updated_at = ? WHERE id = ?").run(message, clockIso(), accountId);
    return { ok: false, reason, message, accountId };
  };
  if (!claimed) return fail("state_used", "That sign-in link was already used. Start again from Nikki.");
  if (currentInstant().getTime() - Date.parse(row.created_at) > STATE_TTL_MS) return fail("state_expired", "The sign-in took longer than 10 minutes. Start again from Nikki.");
  if (!sessionStillValid(db, row.session_id)) return fail("session_ended", "The Nikki session that started this sign-in has ended. Sign in to Nikki and start again.");
  if (q.error) return fail(q.error === "access_denied" ? "denied" : "google_error", q.error === "access_denied" ? "You cancelled on Google's screen, so nothing was connected." : `Google stopped the sign-in (${q.error.slice(0, 60)}).`);
  if (!q.code || !verifier) return fail("no_code", "Google didn't send a sign-in code. Start again from Nikki.");
  const acc = googleAccount(db, accountId);
  if (!acc) return { ok: false, reason: "no_account", message: "That account was removed while you were signing in." };

  const setup = googleSetup();
  let tok: Record<string, any>;
  try {
    const res = await googleFetch(endpoints().token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: q.code, client_id: setup.clientId, client_secret: setup.clientSecret, redirect_uri: setup.redirectUri, grant_type: "authorization_code", code_verifier: verifier }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    tok = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      const why = String(tok.error ?? res.status);
      return fail("token_exchange", why === "invalid_client" ? "Google didn't accept Nikki's client details. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Railway." : why === "redirect_uri_mismatch" ? "The redirect address in Google Cloud doesn't match Nikki's. Check it's exactly the one shown in Nikki." : `Google refused the sign-in code (${why.slice(0, 40)}).`);
    }
  } catch {
    return fail("network", "Couldn't reach Google to finish signing in. Try again.");
  }

  const access = String(tok.access_token ?? "");
  const refresh = String(tok.refresh_token ?? "");
  const granted = String(tok.scope ?? "").split(/\s+/).filter(Boolean);
  let claims: Record<string, any>;
  try {
    claims = decodeIdToken(String(tok.id_token ?? ""));
  } catch {
    if (access) await revokeAtGoogle(access);
    return fail("no_identity", "Google didn't confirm which account signed in, so nothing was connected.");
  }
  const email = normEmail(String(claims.email ?? ""));
  const reject = async (reason: string, message: string) => {
    await revokeAtGoogle(refresh || access);
    return fail(reason, message);
  };
  if (!email || claims.email_verified === false) return reject("unverified", "Google says this account's email isn't verified, so nothing was connected.");
  if (claims.hd) return reject("managed_account", `${email} is managed by an organisation (${String(claims.hd).slice(0, 60)}). Only personal Gmail accounts can be connected at this stage, so nothing was connected and Nikki's access was cancelled.`);
  if (acc.email && normEmail(acc.email) !== email) return reject("wrong_account", `You signed in as ${email}, but this account is for ${acc.email}. Nothing was connected and Nikki's access was cancelled. Start again and choose ${acc.email} on Google's screen.`);
  const sub = String(claims.sub ?? "");
  const prevSub = (db.prepare("SELECT google_sub FROM connected_accounts WHERE id = ?").get(accountId) as { google_sub: string | null }).google_sub;
  if (prevSub && sub && prevSub !== sub) return reject("wrong_account", "That's a different Google account from the one connected before. Nothing was changed.");
  const other = db.prepare("SELECT id FROM connected_accounts WHERE google_sub = ? AND id != ? AND status IN ('connected','needs_reconnect')").get(sub, accountId);
  if (other) return reject("duplicate_account", `${email} is already connected in Nikki.`);
  const services: Service[] = [];
  if (granted.includes(SCOPE_GMAIL_READ)) services.push("gmail");
  if (granted.includes(SCOPE_CALENDAR_READ)) services.push("calendar");
  if (!services.length) return reject("no_scopes", "Neither Gmail nor Calendar was allowed on Google's screen, so there was nothing to connect. Start again and tick both boxes.");
  if (!refresh) return reject("no_refresh", "Google didn't give Nikki lasting access. Start again; if it keeps happening, remove Nikki under myaccount.google.com → Security → Third-party connections, then reconnect.");
  const unexpected = granted.filter((s) => !(GOOGLE_SCOPES as readonly string[]).includes(s) && !/^https:\/\/www\.googleapis\.com\/auth\/userinfo\.(email|profile)$/.test(s));
  if (unexpected.length) return reject("extra_scopes", "Google granted more access than Nikki asked for, so Nikki cancelled it to be safe. Start again.");

  try {
    putSecret(db, `account:${accountId}`, JSON.stringify({ refreshToken: refresh, scopes: granted, grantedAt: clockIso() }), "credential");
  } catch (e) {
    await revokeAtGoogle(refresh);
    return fail("no_key", (e as Error).message);
  }
  const now = clockIso();
  db.prepare(
    `UPDATE connected_accounts SET credential_key = ?, scopes = ?, status = 'connected', last_error = NULL, email = ?, display_name = ?, account_type = 'personal',
     google_sub = ?, services = ?, connected_at = COALESCE(connected_at, ?), sync_status = 'waiting', updated_at = ? WHERE id = ?`,
  ).run(`account:${accountId}`, JSON.stringify(granted), email, String(claims.name ?? "").slice(0, 80) || null, sub, JSON.stringify(services), now, now, accountId);
  tokens.set(accountId, { token: access, exp: currentInstant().getTime() + Math.max(60, Number(tok.expires_in ?? 3600) - 60) * 1000 });
  logActivity(db, "user", acc.status === "needs_reconnect" || prevSub ? "account.reconnected" : "account.connected", accountId, { count: services.length }, acc.spaceId);
  return { ok: true, accountId };
}

// ---------- access tokens ----------

const tokens = new Map<string, { token: string; exp: number }>();
const refreshing = new Map<string, Promise<string>>();

export async function markNeedsReconnect(db: DB, accountId: string, why: string) {
  const acc = googleAccount(db, accountId);
  if (!acc || acc.status === "revoked") return;
  tokens.delete(accountId);
  db.prepare("UPDATE connected_accounts SET status = 'needs_reconnect', last_error = ?, updated_at = ? WHERE id = ?").run(why, clockIso(), accountId);
  logActivity(db, "system", "account.needs_reconnect", accountId, {}, acc.spaceId);
  await notify(db, {
    category: "security",
    priority: "high",
    title: "Google needs you to sign in again",
    body: `Nikki can't read ${acc.email ?? "your Google account"} until you reconnect it. Nothing in Gmail or Calendar was changed.`,
    link: "/?view=context#accounts",
    spaceId: acc.spaceId,
    dedupeKey: `google-reconnect:${accountId}:${clockIso().slice(0, 10)}`,
  }).catch(() => undefined);
}

/** A valid access token for an account, refreshing it when needed. Throws GoogleError("auth") if Google says no. */
export async function accessToken(db: DB, accountId: string, force = false): Promise<string> {
  const cached = tokens.get(accountId);
  if (!force && cached && cached.exp > currentInstant().getTime()) return cached.token;
  const running = refreshing.get(accountId);
  if (running) return running;
  const p = (async () => {
    const raw = getSecret(db, `account:${accountId}`);
    if (!raw) throw new GoogleError("This account isn't connected.", "auth", 401);
    const { refreshToken } = parse<{ refreshToken?: string }>(raw, {});
    if (!refreshToken) throw new GoogleError("This account isn't connected.", "auth", 401);
    const setup = googleSetup();
    let res: Response;
    try {
      res = await googleFetch(endpoints().token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: setup.clientId, client_secret: setup.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GoogleError("Couldn't reach Google.", "network");
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !body.access_token) {
      if (body.error === "invalid_grant" || res.status === 400 || res.status === 401) {
        await markNeedsReconnect(db, accountId, "Google ended Nikki's access (the sign-in expired or was removed).");
        throw new GoogleError("Google needs you to sign in again.", "auth", 401);
      }
      throw new GoogleError(`Google couldn't refresh access (${String(body.error ?? res.status).slice(0, 40)}).`, "server");
    }
    tokens.set(accountId, { token: body.access_token, exp: currentInstant().getTime() + Math.max(60, Number(body.expires_in ?? 3600) - 60) * 1000 });
    return body.access_token as string;
  })();
  refreshing.set(accountId, p);
  try {
    return await p;
  } finally {
    refreshing.delete(accountId);
  }
}

// ---------- disconnect ----------

/**
 * Disconnects: revokes Nikki's access at Google (best effort), deletes the stored token, and removes Nikki's copies of
 * Google data for this account (calendar events, and email results kept in chat). Tasks, plans, notes, reminders and
 * anything you wrote in Nikki are kept. Nothing in Gmail or Google Calendar changes.
 */
export async function disconnectGoogle(db: DB, accountId: string, rebuild: (dates: string[]) => void): Promise<{ revokedAtGoogle: boolean; removedEvents: number; clearedMessages: number }> {
  const acc = googleAccount(db, accountId);
  if (!acc) throw new UserFacingError("That account doesn't exist.", 404, "not_found");
  const raw = getSecret(db, `account:${accountId}`);
  const refresh = parse<{ refreshToken?: string }>(raw, {}).refreshToken;
  const revokedAtGoogle = refresh ? await revokeAtGoogle(refresh) : false;
  tokens.delete(accountId);
  forgetMcpSessions(accountId);
  const out = purgeGoogleData(db, accountId, rebuild);
  deleteSecret(db, `account:${accountId}`);
  db.prepare("UPDATE connected_accounts SET credential_key = NULL, status = 'revoked', scopes = '[]', services = '[]', sync_status = NULL, last_error = NULL, updated_at = ? WHERE id = ?").run(clockIso(), accountId);
  logActivity(db, "user", "account.disconnected", accountId, { count: out.removedEvents }, acc.spaceId);
  return { revokedAtGoogle, ...out };
}

/** Removes Nikki's copies of one account's Google data. */
export function purgeGoogleData(db: DB, accountId: string, rebuild: (dates: string[]) => void) {
  const dates = (db.prepare("SELECT DISTINCT date FROM meetings WHERE feed_id LIKE ?").all(`google:${accountId}:%`) as { date: string }[]).map((r) => r.date);
  const removedEvents = db.prepare("DELETE FROM meetings WHERE feed_id LIKE ?").run(`google:${accountId}:%`).changes;
  db.prepare("DELETE FROM google_events WHERE account_id = ?").run(accountId);
  const clearedMessages = clearEmailFromChat(db, (g) => g.accountId === accountId);
  if (dates.length) rebuild(dates);
  return { removedEvents, clearedMessages };
}

/** Email results shown in chat keep only headers (sender, subject, date). They are removed on disconnect and after 30 days. */
export function clearEmailFromChat(db: DB, match: (g: { accountId?: string }, createdAt: string) => boolean): number {
  const rows = db.prepare("SELECT id, meta, created_at FROM messages WHERE meta LIKE '%\"google\"%'").all() as { id: string; meta: string; created_at: string }[];
  let n = 0;
  const upd = db.prepare("UPDATE messages SET meta = ?, text = ? WHERE id = ?");
  for (const r of rows) {
    const meta = parse<Record<string, any>>(r.meta, {});
    const g = meta.google;
    if (!g || g.kind !== "email" || !match(g, r.created_at)) continue;
    delete meta.google;
    upd.run(JSON.stringify(meta), "Email results were removed (account disconnected or older than 30 days).", r.id);
    n++;
  }
  return n;
}

export function removeGoogleAccount(db: DB, accountId: string, rebuild: (dates: string[]) => void) {
  const acc = googleAccount(db, accountId);
  if (!acc) return;
  if (acc.status !== "revoked" && acc.status !== "not_connected") throw new UserFacingError("Disconnect the account first.", 409, "still_connected");
  purgeGoogleData(db, accountId, rebuild);
  deleteSecret(db, `account:${accountId}`);
  db.prepare("DELETE FROM connected_accounts WHERE id = ?").run(accountId);
  logActivity(db, "user", "account.removed", accountId, {}, acc.spaceId);
}

export function setCalendarSelection(db: DB, accountId: string, selected: string[]) {
  const acc = googleAccount(db, accountId);
  if (!acc) throw new UserFacingError("That account doesn't exist.", 404, "not_found");
  const next = acc.calendars.map((c) => ({ ...c, selected: !c.skippedReason && selected.includes(c.id) }));
  db.prepare("UPDATE connected_accounts SET calendars = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), clockIso(), accountId);
}

export function setAccountSpace(db: DB, accountId: string, spaceId: string) {
  const acc = googleAccount(db, accountId);
  if (!acc) throw new UserFacingError("That account doesn't exist.", 404, "not_found");
  const s = requireSpace(db, spaceId);
  if (s.confidential) throw new UserFacingError("Accounts can't be moved into the confidential space.", 403, "confidential_space");
  db.prepare("UPDATE connected_accounts SET space_id = ?, updated_at = ? WHERE id = ?").run(s.id, clockIso(), accountId);
  logActivity(db, "user", "account.space_changed", accountId, {}, s.id);
}
