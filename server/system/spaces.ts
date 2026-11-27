import { clockIso, newId, type DB } from "../db.js";
import { UserFacingError } from "../errors.js";
import { putSecret, deleteSecret, SecretUnavailableError } from "../security/secrets.js";
import { logActivity } from "./activity.js";

/**
 * Spaces keep different parts of life apart (personal, Revivo, Avagama, consulting, government). Every connected
 * account, agent and action belongs to exactly one space, and the server refuses anything that crosses a boundary.
 * The government space is confidential: off by default, never sent to an AI model, and it can only be turned on by
 * the user from a signed-in, recently verified session.
 */

export interface Space {
  id: string;
  name: string;
  description: string;
  confidential: boolean;
  enabled: boolean;
  aiAllowed: boolean;
}

const DEFAULT_SPACES: { id: string; name: string; description: string; confidential: boolean; enabled?: boolean; aiAllowed?: boolean }[] = [
  { id: "personal", name: "Personal", description: "Your own life, health, family and money.", confidential: false },
  { id: "revivo", name: "Revivo", description: "Revivo work and clients.", confidential: false },
  { id: "avagama", name: "Avagama", description: "The resort.", confidential: false },
  { id: "consulting", name: "Consulting", description: "Consulting engagements.", confidential: false },
  { id: "other", name: "Other", description: "Anything that fits nowhere else.", confidential: false },
  {
    id: "government",
    name: "Government (confidential)",
    description: "Locked. Not connected, never sent to AI. Needs your organisation's authorisation before any use.",
    confidential: true,
    enabled: false,
    aiAllowed: false,
  },
];

export function seedSpaces(db: DB) {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO spaces (id, name, description, confidential, enabled, ai_allowed, sort) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  DEFAULT_SPACES.forEach((s, i) => ins.run(s.id, s.name, s.description, s.confidential ? 1 : 0, s.enabled === false ? 0 : 1, s.aiAllowed === false ? 0 : 1, i));
}

type Row = { id: string; name: string; description: string; confidential: number; enabled: number; ai_allowed: number };
const toSpace = (r: Row): Space => ({ id: r.id, name: r.name, description: r.description, confidential: !!r.confidential, enabled: !!r.enabled, aiAllowed: !!r.ai_allowed && !r.confidential });

export function listSpaces(db: DB): Space[] {
  seedSpaces(db);
  return (db.prepare("SELECT * FROM spaces ORDER BY sort").all() as Row[]).map(toSpace);
}

export function getSpace(db: DB, id: string): Space | null {
  seedSpaces(db);
  const r = db.prepare("SELECT * FROM spaces WHERE id = ?").get(id) as Row | undefined;
  return r ? toSpace(r) : null;
}

/** Throws unless the space exists and is enabled (and, when `forAi`, may be shown to an AI model). */
export function requireSpace(db: DB, id: string, opts: { forAi?: boolean } = {}): Space {
  const s = getSpace(db, id);
  if (!s) throw new UserFacingError("That space doesn't exist.", 400, "unknown_space");
  if (!s.enabled) throw new UserFacingError(`The ${s.name} space is switched off.`, 403, "space_disabled");
  if (opts.forAi && !s.aiAllowed) throw new UserFacingError(`Data from the ${s.name} space is never sent to an AI model.`, 403, "space_no_ai");
  return s;
}

export function setSpaceEnabled(db: DB, id: string, enabled: boolean) {
  const s = getSpace(db, id);
  if (!s) throw new UserFacingError("That space doesn't exist.", 400, "unknown_space");
  // AI access for a confidential space can never be switched on from the app (toSpace forces it off).
  db.prepare("UPDATE spaces SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  logActivity(db, "user", enabled ? "space.enabled" : "space.disabled", id, {}, id);
}

// ---------- connected accounts (records only in Phase 0: nothing connects to a live provider yet) ----------

export type AccountProvider = "google_personal" | "google_workspace" | "github" | "apple_health" | "other";
export type AccountStatus = "not_connected" | "connected" | "needs_reconnect" | "revoked" | "error";

export interface ConnectedAccount {
  id: string;
  provider: AccountProvider;
  label: string;
  accountHint: string | null;
  spaceId: string;
  status: AccountStatus;
  scopes: string[];
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

type AccRow = {
  id: string;
  provider: AccountProvider;
  label: string;
  account_hint: string | null;
  space_id: string;
  status: AccountStatus;
  scopes: string;
  credential_key: string | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
};
const toAccount = (r: AccRow): ConnectedAccount => ({
  id: r.id,
  provider: r.provider,
  label: r.label,
  accountHint: r.account_hint,
  spaceId: r.space_id,
  status: r.status,
  scopes: JSON.parse(r.scopes),
  hasCredential: !!r.credential_key,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastError: r.last_error,
});

export function listAccounts(db: DB): ConnectedAccount[] {
  return (db.prepare("SELECT * FROM connected_accounts ORDER BY created_at").all() as AccRow[]).map(toAccount);
}

export function getAccount(db: DB, id: string): ConnectedAccount | null {
  const r = db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(id) as AccRow | undefined;
  return r ? toAccount(r) : null;
}

/** Registers an account placeholder in a space. Confidential spaces refuse accounts entirely in Phase 0. */
export function addAccount(db: DB, a: { provider: AccountProvider; label: string; spaceId: string; accountHint?: string | null }): ConnectedAccount {
  const space = requireSpace(db, a.spaceId);
  if (space.confidential) throw new UserFacingError("Confidential government accounts can't be connected without your organisation's authorisation.", 403, "confidential_space");
  const id = newId("acct");
  const now = clockIso();
  db.prepare(
    "INSERT INTO connected_accounts (id, provider, label, account_hint, space_id, status, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'not_connected', '[]', ?, ?)",
  ).run(id, a.provider, a.label.slice(0, 80), a.accountHint?.slice(0, 120) ?? null, a.spaceId, now, now);
  logActivity(db, "user", "account.added", id, { kind: a.provider }, a.spaceId);
  return getAccount(db, id)!;
}

/** Stores an account's token, sealed. Refused when the server has no encryption key (never stored in plain text). */
export function storeAccountCredential(db: DB, id: string, token: string, scopes: string[]) {
  const acc = getAccount(db, id);
  if (!acc) throw new UserFacingError("That account doesn't exist.", 404, "not_found");
  const key = `account:${id}`;
  try {
    putSecret(db, key, token, "credential");
  } catch (e) {
    if (e instanceof SecretUnavailableError) throw new UserFacingError(e.message, 409, "no_encryption_key");
    throw e;
  }
  db.prepare("UPDATE connected_accounts SET credential_key = ?, scopes = ?, status = 'connected', updated_at = ?, last_error = NULL WHERE id = ?").run(
    key,
    JSON.stringify(scopes),
    clockIso(),
    id,
  );
  logActivity(db, "system", "account.credential_stored", id, { count: scopes.length }, acc.spaceId);
}

/** Disconnecting deletes the stored token immediately (required by Google's AI tools terms: no retention after revocation). */
export function disconnectAccount(db: DB, id: string) {
  const acc = getAccount(db, id);
  if (!acc) throw new UserFacingError("That account doesn't exist.", 404, "not_found");
  deleteSecret(db, `account:${id}`);
  db.prepare("UPDATE connected_accounts SET credential_key = NULL, status = 'revoked', scopes = '[]', updated_at = ? WHERE id = ?").run(clockIso(), id);
  logActivity(db, "user", "account.disconnected", id, {}, acc.spaceId);
}

export function removeAccount(db: DB, id: string) {
  const acc = getAccount(db, id);
  if (!acc) return;
  deleteSecret(db, `account:${id}`);
  db.prepare("DELETE FROM connected_accounts WHERE id = ?").run(id);
  logActivity(db, "user", "account.removed", id, {}, acc.spaceId);
}

// ---------- permission levels ----------

/**
 * Every tool and action has one level. Enforcement is in code (tools.ts gateway and actions.ts executor), never in a
 * prompt. `consequential` always needs a human approval of the exact action; `prohibited` never runs.
 */
export const LEVELS = ["read", "prepare", "change", "consequential", "prohibited"] as const;
export type Level = (typeof LEVELS)[number];
export const levelRank = (l: Level) => LEVELS.indexOf(l);
