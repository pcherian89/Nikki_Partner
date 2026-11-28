import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "../config.js";
import { clockIso, getDb, getSetting, newId, setSetting, type DB } from "../db.js";
import { UserFacingError } from "../errors.js";
import { logActivity } from "../system/activity.js";
import { notify } from "../system/notifications.js";
import { currentInstant } from "../time.js";
import { getSecret, putSecret, deleteSecret, SecretUnavailableError } from "./secrets.js";
import { counterAt, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from "./totp.js";

/**
 * Sign-in for a single-owner app.
 *
 * - Each sign-in creates its own device session: a random 256-bit token in an HttpOnly, SameSite=Strict cookie. Only
 *   the token's SHA-256 hash is stored, so a copy of the database can't be used to sign in.
 * - Sessions slide forward 30 days with use, and end after 90 days regardless. Each can be renamed or signed out
 *   from Context → Security; "Sign out everywhere else" ends all the others.
 * - Sensitive steps (approving consequential actions, turning 2FA off, downloading a backup, enabling a confidential
 *   space) need a recent password check on this device ("step-up", 15 minutes).
 * - Guessing is limited per address (5 per 5 minutes) and overall (20 per 15 minutes locks sign-in for 15 minutes
 *   and sends a security notification).
 * - Optional two-step sign-in with 6-digit codes (TOTP) plus 8 one-use recovery codes. The code secret is sealed
 *   with the server key, so 2FA needs NIKKI_ENCRYPTION_KEY. Recovery if every device and code is lost: set
 *   NIKKI_DISABLE_2FA=1 in Railway for one deploy, sign in, turn 2FA off, remove the variable.
 *
 * The old fixed cookie (nikki_session) from before Phase 0 is no longer accepted: every device signs in once more.
 */

export const SESSION_COOKIE = "nikki_sid";
const SLIDE_MS = 30 * 86400_000;
const ABSOLUTE_MS = 90 * 86400_000;
const STEP_UP_MS = 15 * 60_000;

export interface SessionInfo {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  verifiedAt: string | null;
  secondFactor: boolean;
}

const sessions = new WeakMap<Request, SessionInfo>();
/** The device session behind this request; null when the server has no password (local use). */
export const sessionOf = (req: Request) => sessions.get(req) ?? null;

const authDb = () => getDb("personal");
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const nowMs = () => currentInstant().getTime();

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function passwordMatches(pw: string) {
  const a = createHmac("sha256", "cmp").update(pw).digest();
  const b = createHmac("sha256", "cmp").update(config.appPassword).digest();
  return !!config.appPassword && timingSafeEqual(a, b);
}

/** A readable device name from the browser's user agent ("iPhone · Safari"). */
export function deviceLabel(ua: string | undefined) {
  const u = ua ?? "";
  const os = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android" : /Macintosh|Mac OS X/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : "Device";
  const br = /Edg\//.test(u) ? "Edge" : /CriOS|Chrome\//.test(u) ? "Chrome" : /FxiOS|Firefox\//.test(u) ? "Firefox" : /Safari\//.test(u) ? "Safari" : "Browser";
  return `${os} · ${br}`;
}

type Row = {
  id: string;
  label: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  absolute_expires_at: string;
  verified_at: string | null;
  second_factor: number;
  revoked_at: string | null;
};
const toInfo = (r: Row): SessionInfo => ({ id: r.id, label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, verifiedAt: r.verified_at, secondFactor: !!r.second_factor });

function createSession(db: DB, label: string, ua: string | undefined, secondFactor: boolean) {
  const token = randomBytes(32).toString("base64url");
  const id = newId("sess");
  const now = nowMs();
  const iso = new Date(now).toISOString();
  db.prepare(
    "INSERT INTO auth_sessions (id, token_hash, label, user_agent, created_at, last_seen_at, expires_at, absolute_expires_at, verified_at, second_factor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, hashToken(token), label.slice(0, 60), (ua ?? "").slice(0, 300), iso, iso, new Date(now + SLIDE_MS).toISOString(), new Date(now + ABSOLUTE_MS).toISOString(), iso, secondFactor ? 1 : 0);
  return { id, token };
}

function lookup(db: DB, token: string): Row | null {
  const r = db.prepare("SELECT * FROM auth_sessions WHERE token_hash = ?").get(hashToken(token)) as Row | undefined;
  if (!r || r.revoked_at) return null;
  const now = nowMs();
  if (new Date(r.expires_at).getTime() < now || new Date(r.absolute_expires_at).getTime() < now) return null;
  // Slide the expiry forward at most once a minute (keeps writes low).
  if (now - new Date(r.last_seen_at).getTime() > 60_000) {
    const exp = new Date(Math.min(now + SLIDE_MS, new Date(r.absolute_expires_at).getTime())).toISOString();
    db.prepare("UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(new Date(now).toISOString(), exp, r.id);
    r.last_seen_at = new Date(now).toISOString();
    r.expires_at = exp;
  }
  return r;
}

const cookie = (req: Request, value: string, maxAgeS: number) =>
  `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}${req.secure ? "; Secure" : ""}`;

// ---------- rate limiting ----------

const perIp = new Map<string, { count: number; until: number }>();
let globalFails: number[] = [];
let lockedUntil = 0;

function checkRate(ip: string) {
  const now = nowMs();
  if (now < lockedUntil) throw new UserFacingError("Sign-in is locked for a few minutes after too many wrong attempts.", 429, "locked");
  const r = perIp.get(ip);
  if (r && r.count >= 5 && now < r.until) throw new UserFacingError("Too many attempts. Wait a few minutes and try again.", 429, "rate_limited");
}

function recordFail(ip: string) {
  const now = nowMs();
  const r = perIp.get(ip);
  perIp.set(ip, { count: (r && now < r.until ? r.count : 0) + 1, until: now + 5 * 60_000 });
  globalFails = [...globalFails.filter((t) => now - t < 15 * 60_000), now];
  if (globalFails.length >= 20) {
    lockedUntil = now + 15 * 60_000;
    globalFails = [];
    const db = authDb();
    logActivity(db, "system", "auth.locked", null, { count: 20 });
    void notify(db, { category: "security", priority: "urgent", title: "Sign-in locked", body: "Nikki saw 20 wrong sign-in attempts in 15 minutes and locked sign-in for 15 minutes.", link: "/?view=context#security", dedupeKey: `locked:${Math.floor(now / 900_000)}` }).catch(() => {});
  }
}

/** For tests. */
export function resetAuthLimits() {
  perIp.clear();
  globalFails = [];
  lockedUntil = 0;
}

// ---------- two-step sign-in ----------

export const totpEnabled = (db: DB) => getSetting(db, "totp_enabled") === "1" && process.env.NIKKI_DISABLE_2FA !== "1";

function checkSecondFactor(db: DB, code: string): boolean {
  const secret = getSecret(db, "totp_secret");
  if (!secret) return false;
  const c = code.trim().toLowerCase();
  if (/^[a-z2-7]{4}-[a-z2-7]{4}$/.test(c)) {
    const hashes: string[] = JSON.parse(getSecret(db, "totp_recovery") ?? "[]");
    const h = hashToken(c);
    if (!hashes.includes(h)) return false;
    putSecret(db, "totp_recovery", JSON.stringify(hashes.filter((x) => x !== h)), "credential");
    logActivity(db, "user", "auth.recovery_code_used", null, { count: hashes.length - 1 });
    return true;
  }
  const counter = verifyTotp(secret, c, nowMs());
  if (counter === null) return false;
  const last = Number(getSetting(db, "totp_last_counter") ?? -1);
  if (counter <= last) return false; // a code can be used only once
  setSetting(db, "totp_last_counter", String(counter));
  return true;
}

export function startTotpSetup(db: DB) {
  const secret = newTotpSecret();
  try {
    putSecret(db, "totp_pending", secret, "credential");
  } catch (e) {
    if (e instanceof SecretUnavailableError) throw new UserFacingError("Two-step sign-in needs the server encryption key first (NIKKI_ENCRYPTION_KEY). See the setup steps.", 409, "no_encryption_key");
    throw e;
  }
  return { secret, uri: otpauthUri(secret) };
}

export function finishTotpSetup(db: DB, code: string): string[] {
  const secret = getSecret(db, "totp_pending");
  if (!secret) throw new UserFacingError("Start the setup again.", 409, "no_pending");
  const counter = verifyTotp(secret, code, nowMs());
  if (counter === null) throw new UserFacingError("That code didn't match. Check the time on your phone and try the newest code.", 400, "bad_code");
  const codes = newRecoveryCodes();
  putSecret(db, "totp_secret", secret, "credential");
  putSecret(db, "totp_recovery", JSON.stringify(codes.map(hashToken)), "credential");
  deleteSecret(db, "totp_pending");
  setSetting(db, "totp_last_counter", String(counter));
  setSetting(db, "totp_enabled", "1");
  logActivity(db, "user", "auth.2fa_enabled");
  return codes;
}

export function disableTotp(db: DB, code: string) {
  if (totpEnabled(db) && !checkSecondFactor(db, code)) throw new UserFacingError("That code didn't match.", 400, "bad_code");
  for (const k of ["totp_secret", "totp_recovery", "totp_pending"]) deleteSecret(db, k);
  setSetting(db, "totp_enabled", "0");
  logActivity(db, "user", "auth.2fa_disabled");
}

export function recoveryCodesLeft(db: DB) {
  try {
    return (JSON.parse(getSecret(db, "totp_recovery") ?? "[]") as string[]).length;
  } catch {
    return 0;
  }
}

// ---------- device sessions ----------

export function listSessions(db: DB): (SessionInfo & { current?: boolean })[] {
  const now = clockIso();
  return (db.prepare("SELECT * FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ? ORDER BY last_seen_at DESC").all(now, now) as Row[]).map(toInfo);
}

export function revokeSession(db: DB, id: string) {
  db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(clockIso(), id);
  logActivity(db, "user", "auth.session_revoked", id, { session: id });
}

export function revokeOthers(db: DB, keepId: string | null) {
  const n = db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND id != ?").run(clockIso(), keepId ?? "").changes;
  logActivity(db, "user", "auth.sessions_revoked_others", keepId, { count: n });
  return n;
}

export function renameSession(db: DB, id: string, label: string) {
  db.prepare("UPDATE auth_sessions SET label = ? WHERE id = ?").run(label.trim().slice(0, 60) || "Device", id);
}

/** Throws unless this device confirmed the password in the last 15 minutes (no-op when no password is set). */
export function requireRecentAuth(req: Request) {
  if (!config.appPassword) return;
  const s = sessionOf(req);
  if (!s?.verifiedAt || nowMs() - new Date(s.verifiedAt).getTime() > STEP_UP_MS) {
    throw new UserFacingError("For your safety, enter your password again to do this.", 401, "reauth_required");
  }
}

// ---------- HTTP ----------

export const authRouter = express.Router();

authRouter.get("/api/auth/status", (req, res) => {
  const db = authDb();
  const token = readCookie(req, SESSION_COOKIE);
  const row = config.appPassword && token ? lookup(db, token) : null;
  res.json({ authRequired: !!config.appPassword, authed: !config.appPassword || !!row, twoFactor: totpEnabled(db) });
});

authRouter.post("/api/auth/login", (req, res, next) => {
  try {
    const ip = req.ip ?? "unknown";
    checkRate(ip);
    const db = authDb();
    const pw = String(req.body?.password ?? "");
    const code = String(req.body?.code ?? "");
    if (!passwordMatches(pw)) {
      recordFail(ip);
      logActivity(db, "system", "auth.login_failed", null, { reason: "password" });
      return res.status(401).json({ error: "Wrong password." });
    }
    const twoFactor = totpEnabled(db);
    if (twoFactor) {
      if (!code) return res.status(401).json({ error: "Enter the 6-digit code from your authenticator app.", code: "totp_required" });
      if (!checkSecondFactor(db, code)) {
        recordFail(ip);
        logActivity(db, "system", "auth.login_failed", null, { reason: "code" });
        return res.status(401).json({ error: "That code didn't match.", code: "totp_required" });
      }
    }
    perIp.delete(ip);
    const label = String(req.body?.deviceLabel ?? "").trim() || deviceLabel(req.header("user-agent"));
    const ua = (req.header("user-agent") ?? "").slice(0, 300);
    // Alert only for a device Nikki hasn't seen: the very first sign-in is you setting Nikki up, and signing in again on
    // the same browser (after signing out or a session expiring) is ordinary use. A browser seen in the last 90 days
    // counts as known. Repeated sign-ins from one new device on one day make one alert, not many.
    const anyBefore = (db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get() as { n: number }).n > 0;
    const seen = !!db.prepare("SELECT 1 FROM auth_sessions WHERE user_agent = ? AND created_at >= ? LIMIT 1").get(ua, new Date(nowMs() - 90 * 86_400_000).toISOString());
    const s = createSession(db, label, ua, twoFactor);
    logActivity(db, "user", "auth.login", s.id, { device: label, session: s.id });
    if (anyBefore && !seen) {
      const day = new Date(nowMs()).toISOString().slice(0, 10);
      void notify(db, { category: "security", priority: "high", title: "Sign-in from a new device", body: `${label} signed in to Nikki. If this wasn't you, sign it out in Context → Security and devices.`, link: "/?view=context#security", dedupeKey: `signin:${createHash("sha256").update(ua).digest("hex").slice(0, 16)}:${day}` }).catch(() => {});
    }
    res.setHeader("Set-Cookie", cookie(req, s.token, SLIDE_MS / 1000));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/api/auth/logout", (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  const db = authDb();
  if (token) {
    const r = db.prepare("SELECT id FROM auth_sessions WHERE token_hash = ?").get(hashToken(token)) as { id: string } | undefined;
    if (r) {
      db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?").run(clockIso(), r.id);
      logActivity(db, "user", "auth.logout", r.id, { session: r.id });
    }
  }
  res.setHeader("Set-Cookie", cookie(req, "", 0));
  res.json({ ok: true });
});

/** Every /api route except sign-in, health and the push acknowledgement needs a valid device session. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.appPassword) return next();
  const token = readCookie(req, SESSION_COOKIE);
  const row = token ? lookup(authDb(), token) : null;
  if (row) {
    sessions.set(req, toInfo(row));
    return next();
  }
  if (req.path === "/health") return next();
  res.status(401).json({ error: "Please log in.", code: "auth_required" });
}

/** Step-up: confirm the password (and code, if 2FA is on) on this device. */
authRouter.post("/api/auth/verify", requireAuth, (req, res, next) => {
  try {
    const ip = req.ip ?? "unknown";
    checkRate(ip);
    const db = authDb();
    const s = sessionOf(req);
    if (!config.appPassword || !s) return res.json({ ok: true });
    if (!passwordMatches(String(req.body?.password ?? ""))) {
      recordFail(ip);
      return res.status(401).json({ error: "Wrong password.", code: "bad_password" });
    }
    if (totpEnabled(db) && !checkSecondFactor(db, String(req.body?.code ?? ""))) {
      recordFail(ip);
      return res.status(401).json({ error: "Enter the current 6-digit code.", code: "totp_required" });
    }
    db.prepare("UPDATE auth_sessions SET verified_at = ? WHERE id = ?").run(clockIso(), s.id);
    logActivity(db, "user", "auth.step_up", s.id, { session: s.id });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export const _testing = { counterAt, hashToken };
