import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clockIso, getSetting, setSetting, type DB } from "../db.js";
import { currentInstant } from "../time.js";
import { openFile, vaultStatus } from "../security/vault.js";
import { logActivity } from "../system/activity.js";
import { AAD, backupPath, listBackups } from "../system/backup.js";

/**
 * Recovery check, required before any Google sign-in is stored (Phase 1 §24).
 *
 * Nightly backups live on the same Railway volume as the database, so they protect against mistakes and bad updates,
 * not against losing the volume. Before Nikki holds Google tokens, these must all be true:
 *   1. The server encryption key is set (tokens and backups are sealed with it).
 *   2. You've confirmed the key is saved outside Railway (for example in Apple Passwords). Without it no backup opens.
 *   3. A recent encrypted backup exists (made in the last 2 days).
 *   4. A restore test passed: Nikki decrypted that backup into a temporary file and SQLite's integrity check passed.
 *   5. A backup was downloaded to one of your devices in the last 7 days (the off-volume copy).
 * Google tokens themselves don't need recovering: after a restore you simply reconnect. The backups protect your
 * Nikki data.
 */

const DAY = 86_400_000;
const KEY_CONFIRMED = "recovery_key_saved_confirmed";
const LAST_CHECK = "recovery_restore_check";

export interface RestoreCheck {
  at: string;
  ok: boolean;
  file: string | null;
  tables: number;
  detail: string;
}

export function lastRestoreCheck(db: DB): RestoreCheck | null {
  try {
    return JSON.parse(getSetting(db, LAST_CHECK) ?? "null");
  } catch {
    return null;
  }
}

/** Decrypts the newest backup into a temporary file, runs SQLite's integrity check, then deletes the copy. */
export function runRestoreCheck(db: DB): RestoreCheck {
  const latest = listBackups()[0];
  let result: RestoreCheck;
  if (!latest) result = { at: clockIso(), ok: false, file: null, tables: 0, detail: "There's no backup yet. Make one first." };
  else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-restore-"));
    const out = path.join(tmp, "restored.db");
    try {
      const data = openFile(fs.readFileSync(backupPath(latest.file)!), AAD);
      fs.writeFileSync(out, data, { mode: 0o600 });
      const r = new Database(out, { readonly: true, fileMustExist: true });
      try {
        const integrity = r.pragma("integrity_check", { simple: true });
        const tables = (r.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
        const hasCore = ["tasks", "messages", "settings"].every((t) => r.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t));
        const ok = integrity === "ok" && hasCore;
        result = { at: clockIso(), ok, file: latest.file, tables, detail: ok ? `Opened ${latest.file} and checked ${tables} tables.` : `The restored copy failed its check (${String(integrity).slice(0, 80)}).` };
      } finally {
        r.close();
      }
    } catch (e) {
      result = { at: clockIso(), ok: false, file: latest.file, tables: 0, detail: `Couldn't open the backup: ${(e as Error).message}` };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  setSetting(db, LAST_CHECK, JSON.stringify(result));
  logActivity(db, "system", result.ok ? "backup.restore_check_passed" : "backup.restore_check_failed", result.file, {});
  return result;
}

export function confirmKeySaved(db: DB, saved: boolean) {
  setSetting(db, KEY_CONFIRMED, saved ? clockIso() : "");
  logActivity(db, "user", saved ? "recovery.key_saved_confirmed" : "recovery.key_saved_unconfirmed", null, {});
}

export function recoveryStatus(db: DB) {
  const now = currentInstant().getTime();
  const vault = vaultStatus();
  const latest = listBackups()[0] ?? null;
  const check = lastRestoreCheck(db);
  const downloaded = db.prepare("SELECT at, subject FROM activity_log WHERE kind = 'backup.downloaded' ORDER BY seq DESC LIMIT 1").get() as { at: string; subject: string } | undefined;
  const keySaved = getSetting(db, KEY_CONFIRMED) || null;
  const items = [
    { id: "key", label: "Encryption key is set on the server", ok: vault.ready, fix: "Add NIKKI_ENCRYPTION_KEY in Railway (see docs/operations.md)." },
    { id: "key_saved", label: "You've saved the encryption key outside Railway", ok: !!keySaved, fix: "Tick the box once the key is in your password manager." },
    { id: "backup", label: "A recent encrypted backup exists", ok: !!latest && now - Date.parse(latest.createdAt) < 2 * DAY, fix: "Tap “Make a backup now”." },
    { id: "restore", label: "A restore test passed", ok: !!check?.ok && !!latest && check.file === latest.file, fix: "Tap “Test a restore”." },
    { id: "offsite", label: "A backup is saved on one of your devices (last 7 days)", ok: !!downloaded && now - Date.parse(downloaded.at) < 7 * DAY, fix: "Tap “Download the latest backup” and keep the file on your Mac." },
  ];
  return {
    ready: items.every((i) => i.ok),
    items,
    missing: items.filter((i) => !i.ok).map((i) => `${i.label}: ${i.fix}`),
    latestBackup: latest,
    restoreCheck: check,
    lastDownloadAt: downloaded?.at ?? null,
    keySavedAt: keySaved,
  };
}
