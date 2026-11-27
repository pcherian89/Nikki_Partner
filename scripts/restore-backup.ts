/**
 * Decrypts a Nikki backup into a normal SQLite file.
 *
 *   NIKKI_ENCRYPTION_KEY=… npx tsx scripts/restore-backup.ts nikki-2026-11-27.db.enc restored.db
 *
 * The key must be the one that was set when the backup was made (or NIKKI_ENCRYPTION_KEY_PREVIOUS after a rotation).
 * To put it back on Railway: stop the service, replace /data/nikki.db with the restored file (keep the old one), and
 * start it again. See docs/operations.md.
 */
import fs from "node:fs";
import { openFile } from "../server/security/vault.js";
import { AAD } from "../server/system/backup.js";

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error("Usage: npx tsx scripts/restore-backup.ts <backup.db.enc> <restored.db>");
  process.exit(1);
}
if (fs.existsSync(output)) {
  console.error(`${output} already exists; choose a new file name so nothing is overwritten.`);
  process.exit(1);
}
const data = openFile(fs.readFileSync(input), AAD);
fs.writeFileSync(output, data, { mode: 0o600 });
console.log(`Restored ${data.length} bytes to ${output}. Check it with: sqlite3 ${output} "PRAGMA integrity_check"`);
