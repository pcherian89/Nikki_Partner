import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Phase 0: sign-in with per-device sessions, step-up, rate limits, 2FA, CSRF and headers. Runs with a password set.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-p0auth-"));
process.env.DATABASE_PATH = path.join(tmp, "nikki.db");
process.env.ANTHROPIC_API_KEY = "";
process.env.APP_PASSWORD = "correct horse battery";
process.env.NIKKI_ENCRYPTION_KEY = randomBytes(32).toString("base64");
delete process.env.NIKKI_FAKE_NOW;

const { app } = await import("../index.js");
const { getDb } = await import("../db.js");
const { resetAuthLimits } = await import("../security/auth.js");
const { totpAt, counterAt } = await import("../security/totp.js");
const { listActivity } = await import("../system/activity.js");

let server: Server;
let base = "";
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method: string, url: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json", "x-workspace": "personal", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1) AppleWebKit Safari/605.1", ...(cookie ? { cookie } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, json, setCookie, headers: res.headers };
}
const cookieOf = (sc: string | null) => (sc ?? "").split(";")[0];
async function login(code?: string) {
  const r = await call("POST", "/api/auth/login", { password: "correct horse battery", ...(code ? { code } : {}) });
  return { ...r, cookie: cookieOf(r.setCookie) };
}

test("every device gets its own random session; the old fixed cookie no longer works", async () => {
  resetAuthLimits();
  assert.equal((await call("GET", "/api/state")).status, 401);
  const a = await login();
  const b = await login();
  assert.equal(a.status, 200);
  assert.match(a.setCookie ?? "", /nikki_sid=[\w-]{40,}; HttpOnly; SameSite=Strict/);
  assert.notEqual(a.cookie, b.cookie, "two sign-ins, two different tokens");
  assert.equal((await call("GET", "/api/state", undefined, a.cookie)).status, 200);
  // The database holds only hashes, never the token itself.
  const token = a.cookie.split("=")[1];
  const dump = JSON.stringify(getDb("personal").prepare("SELECT * FROM auth_sessions").all());
  assert.ok(!dump.includes(token), "token not stored");
  // The pre-Phase-0 cookie is refused.
  assert.equal((await call("GET", "/api/state", undefined, "nikki_session=abc")).status, 401);
});

test("a device can be signed out remotely, and 'sign out everywhere else' keeps only this one", async () => {
  resetAuthLimits();
  const a = await login();
  const b = await login();
  const c = await login();
  const ov = (await call("GET", "/api/system/overview", undefined, a.cookie)).json;
  const bId = ov.security.sessions.find((s: any) => !s.current && s.id)?.id;
  assert.ok(ov.security.sessions.some((s: any) => s.current), "this device is marked");
  assert.equal(ov.security.sessions[0].label, "iPhone · Safari");
  await call("POST", `/api/system/sessions/${bId}/revoke`, {}, a.cookie);
  const after1 = (await call("GET", "/api/system/overview", undefined, a.cookie)).json;
  assert.ok(!after1.security.sessions.some((s: any) => s.id === bId), "revoked device is gone from the list");
  await call("POST", "/api/system/sessions/revoke-others", {}, a.cookie);
  assert.equal((await call("GET", "/api/state", undefined, b.cookie)).status, 401);
  assert.equal((await call("GET", "/api/state", undefined, c.cookie)).status, 401);
  assert.equal((await call("GET", "/api/state", undefined, a.cookie)).status, 200);
  await call("POST", "/api/auth/logout", {}, a.cookie);
  assert.equal((await call("GET", "/api/state", undefined, a.cookie)).status, 401, "logout ends the session on the server");
});

test("wrong passwords are limited per address", async () => {
  resetAuthLimits();
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/auth/login", { password: "nope" })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { password: "correct horse battery" })).status, 429, "locked out even with the right password");
  assert.ok(listActivity(getDb("personal"), 50).some((e) => e.kind === "auth.login_failed"));
  resetAuthLimits();
});

test("sensitive steps need a fresh password check (step-up)", async () => {
  resetAuthLimits();
  const a = await login();
  const db = getDb("personal");
  // Make this session's last check old.
  db.prepare("UPDATE auth_sessions SET verified_at = ?").run(new Date(Date.now() - 60 * 60_000).toISOString());
  const r = await call("POST", "/api/system/2fa/setup", {}, a.cookie);
  assert.equal(r.status, 401);
  assert.equal(r.json.code, "reauth_required");
  assert.equal((await call("POST", "/api/auth/verify", { password: "wrong" }, a.cookie)).status, 401);
  assert.equal((await call("POST", "/api/auth/verify", { password: "correct horse battery" }, a.cookie)).status, 200);
  assert.equal((await call("POST", "/api/system/2fa/setup", {}, a.cookie)).status, 200);
});

test("two-step sign-in: codes, one use per code, recovery codes, secret sealed", async () => {
  resetAuthLimits();
  const a = await login();
  const setup = (await call("POST", "/api/system/2fa/setup", {}, a.cookie)).json;
  assert.match(setup.uri, /^otpauth:\/\/totp\/Nikki\?secret=[A-Z2-7]+/);
  assert.equal((await call("POST", "/api/system/2fa/enable", { code: "000000" }, a.cookie)).status, 400);
  const code = totpAt(setup.secret, counterAt(Date.now()));
  const en = await call("POST", "/api/system/2fa/enable", { code }, a.cookie);
  assert.equal(en.status, 200);
  assert.equal(en.json.recoveryCodes.length, 8);
  const stored = (getDb("personal").prepare("SELECT value FROM secrets WHERE key = 'totp_secret'").get() as { value: string }).value;
  assert.ok(stored.startsWith("enc:v1:"), "the 2FA secret is encrypted at rest");
  assert.ok(!stored.includes(setup.secret));
  // Password alone is no longer enough.
  const noCode = await call("POST", "/api/auth/login", { password: "correct horse battery" });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.json.code, "totp_required");
  // The same code can't be used twice.
  assert.equal((await login(code)).status, 401, "replayed code refused");
  const next = totpAt(setup.secret, counterAt(Date.now()) + 1);
  assert.equal((await login(next)).status, 200, "next code (clock drift window) accepted");
  // A recovery code works once.
  const rc = en.json.recoveryCodes[0];
  assert.equal((await login(rc)).status, 200);
  resetAuthLimits();
  assert.equal((await login(rc)).status, 401, "recovery code used up");
  // Turn it off again (fresh session counts as verified).
  resetAuthLimits();
  const fresh = await login(en.json.recoveryCodes[1]);
  assert.equal((await call("POST", "/api/system/2fa/disable", { code: en.json.recoveryCodes[2] }, fresh.cookie)).status, 200);
  assert.equal((await login()).status, 200);
});

test("requests from another site are refused; security headers are set", async () => {
  resetAuthLimits();
  const a = await login();
  const cross = await call("POST", "/api/reminders", { title: "x", date: "2030-01-01", time: "09:00" }, a.cookie, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.code, "cross_site");
  const site = await call("POST", "/api/system/controls", { control: "agents", paused: true }, a.cookie, { "sec-fetch-site": "cross-site" });
  assert.equal(site.status, 403);
  const same = await call("GET", "/api/system/overview", undefined, a.cookie, { origin: base });
  assert.equal(same.status, 200);
  const csp = same.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(same.headers.get("x-content-type-options"), "nosniff");
  assert.equal(same.headers.get("cache-control"), "no-store");
});

test("sign-in alerts: none for a browser already seen, one per new device per day, kept as a security notice", async () => {
  resetAuthLimits();
  const alerts = () => (getDb("personal").prepare("SELECT COUNT(*) AS n FROM notifications WHERE title = 'Sign-in from a new device'").get() as { n: number }).n;
  const start = alerts();
  await login(); // same iPhone browser as the earlier tests
  await login();
  assert.equal(alerts(), start, "a known browser signing in again is ordinary use");
  const mac = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit Safari/605.1" };
  await call("POST", "/api/auth/login", { password: "correct horse battery" }, undefined, mac);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(alerts(), start + 1, "a new device makes one alert");
  const row = getDb("personal").prepare("SELECT category, priority FROM notifications WHERE title = 'Sign-in from a new device' ORDER BY created_at DESC LIMIT 1").get() as any;
  assert.equal(row.category, "security");
  assert.equal(row.priority, "high");
});
