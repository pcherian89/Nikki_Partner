import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { type DB } from "../db.js";
import { currentInstant, localNow } from "../time.js";
import { openFile, sealFile, vaultStatus } from "../security/vault.js";
import { logActivity } from "./activity.js";
import { notifyTz } from "./notifications.js";

/**
 * Nightly encrypted backups of the personal database, kept on the same Railway volume for 14 days.
 *
 * - Made with SQLite's online backup (consistent even while Nikki is in use), then sealed with the server key
 *   (AES-256-GCM). The plain copy is deleted immediately.
 * - Without NIKKI_ENCRYPTION_KEY no nightly backup is written (an unencrypted downloadable copy would include
 *   everything); the Safety screen says so.
 * - This protects against mistakes and bad updates, not against losing the whole volume: turn on Railway's own
 *   volume backups for that (see docs/operations.md).
 * - Restore: `npx tsx scripts/restore-backup.ts <file.enc> <restored.db>` with the same key in the environment.
 */

export const AAD = "backup:nikki.db";
const KEEP_DAYS = 14;
export const backupDir = () => path.join(path.dirname(config.databasePath), "backups");

export interface BackupInfo {
  file: string;
  bytes: number;
  createdAt: string;
}

export function listBackups(): BackupInfo[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^nikki-\d{4}-\d{2}-\d{2}(-\d+)?\.db\.enc$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, bytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.file.localeCompare(a.file));
}

export async function makeBackup(db: DB): Promise<BackupInfo | null> {
  if (!vaultStatus().ready) {
    logActivity(db, "system", "backup.skipped", null, { reason: "no_key" });
    return null;
  }
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const day = localNow(notifyTz(db)).date;
  let name = `nikki-${day}.db.enc`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `nikki-${day}-${i}.db.enc`;
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.db`);
  try {
    await db.backup(tmp);
    const sealed = sealFile(fs.readFileSync(tmp), AAD);
    fs.writeFileSync(path.join(dir, name), sealed, { mode: 0o600 });
    // Verify the file opens before trusting it.
    openFile(fs.readFileSync(path.join(dir, name)), AAD);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  pruneBackups();
  const info = listBackups().find((b) => b.file === name)!;
  logActivity(db, "system", "backup.created", name, { count: info.bytes });
  return info;
}

export function pruneBackups() {
  const cutoff = currentInstant().getTime() - KEEP_DAYS * 86400_000;
  for (const b of listBackups()) if (new Date(b.createdAt).getTime() < cutoff) fs.rmSync(path.join(backupDir(), b.file), { force: true });
}

/** Path of a backup by name, refusing anything that isn't one of ours (no path tricks). */
export function backupPath(file: string): string | null {
  const b = listBackups().find((x) => x.file === file);
  return b ? path.join(backupDir(), b.file) : null;
}
