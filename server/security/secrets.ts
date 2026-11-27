import type { DB } from "../db.js";
import { isSealed, needsRewrap, open, seal, vaultStatus } from "./vault.js";

/**
 * The one place secrets are read and written (the `secrets` table). Values are sealed with the server key
 * (security/vault.ts) and bound to their row name, so a copied value will not open elsewhere.
 *
 * - `sensitivity: "credential"` (OAuth tokens, 2FA secrets): refused outright when no key is configured.
 * - `sensitivity: "operational"` (the push signing key): stored in plain text only while no key is configured, so
 *   notifications keep working on a server that has not been given a key yet; sealed as soon as one is.
 */
export type Sensitivity = "credential" | "operational";

const aad = (key: string) => `secret:${key}`;

export class SecretUnavailableError extends Error {}

export function getSecret(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM secrets WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return null;
  return isSealed(row.value) ? open(row.value, aad(key)) : row.value;
}

export function putSecret(db: DB, key: string, value: string, sensitivity: Sensitivity) {
  const ready = vaultStatus().ready;
  if (!ready && sensitivity === "credential") {
    throw new SecretUnavailableError("This needs the server encryption key (NIKKI_ENCRYPTION_KEY), which is not set yet.");
  }
  const stored = ready ? seal(value, aad(key)) : value;
  db.prepare("INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, stored);
}

export function deleteSecret(db: DB, key: string) {
  db.prepare("DELETE FROM secrets WHERE key = ?").run(key);
}

/** Seals any plain-text secret and re-seals values still under the previous key. Safe to run on every start. */
export function protectStoredSecrets(db: DB): { sealed: number; rewrapped: number } {
  if (!vaultStatus().ready) return { sealed: 0, rewrapped: 0 };
  const rows = db.prepare("SELECT key, value FROM secrets").all() as { key: string; value: string }[];
  let sealed = 0;
  let rewrapped = 0;
  const upd = db.prepare("UPDATE secrets SET value = ? WHERE key = ?");
  db.transaction(() => {
    for (const r of rows) {
      if (!isSealed(r.value)) {
        upd.run(seal(r.value, aad(r.key)), r.key);
        sealed++;
      } else if (needsRewrap(r.value)) {
        upd.run(seal(open(r.value, aad(r.key)), aad(r.key)), r.key);
        rewrapped++;
      }
    }
  })();
  return { sealed, rewrapped };
}

/** Counts for the security screen; never returns values. */
export function secretsSummary(db: DB) {
  const rows = db.prepare("SELECT value FROM secrets").all() as { value: string }[];
  return { total: rows.length, sealed: rows.filter((r) => isSealed(r.value)).length };
}
