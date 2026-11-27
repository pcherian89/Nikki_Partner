/**
 * Only needed if you roll Nikki back to a version from before Phase 0 AFTER the encryption key was set.
 * Older versions can't read encrypted values, so this turns the push signing key back into plain text (the only
 * secret older versions use). Two-step sign-in secrets and account tokens are removed instead, because older
 * versions don't use them and they must never sit in plain text.
 *
 * Run in Railway → service → Console, with the service's variables available:
 *   npx tsx scripts/unseal-for-rollback.ts
 */
import Database from "better-sqlite3";
import { config } from "../server/config.js";
import { isSealed, open } from "../server/security/vault.js";

const db = new Database(config.databasePath);
const rows = db.prepare("SELECT key, value FROM secrets").all() as { key: string; value: string }[];
let unsealed = 0;
let removed = 0;
for (const r of rows) {
  if (!isSealed(r.value)) continue;
  if (r.key === "vapid_public" || r.key === "vapid_private") {
    db.prepare("UPDATE secrets SET value = ? WHERE key = ?").run(open(r.value, `secret:${r.key}`), r.key);
    unsealed++;
  } else {
    db.prepare("DELETE FROM secrets WHERE key = ?").run(r.key);
    removed++;
  }
}
console.log(`Push key restored to plain text (${unsealed} values). Removed ${removed} Phase 0 secrets that older versions don't use.`);
