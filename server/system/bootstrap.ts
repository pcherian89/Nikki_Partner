import type { DB } from "../db.js";
import { protectStoredSecrets } from "../security/secrets.js";
import { vaultStatus } from "../security/vault.js";
import { ensureExampleAgent } from "../agents/profiles.js";
import "../agents/engine.js"; // registers the agent job handler
import { logActivity } from "./activity.js";
import { recoverActions, runScheduledActions } from "./actions.js";
import { makeBackup, pruneBackups } from "./backup.js";
import { meteringSince } from "./budget.js";
import { recoverJobs, registerJobHandler, upsertJob } from "./jobs.js";
import { pruneNotifications, sendQuietDigest } from "./notifications.js";
import { seedSpaces } from "./spaces.js";
import { runRestoreCheck } from "../google/recovery.js";
import { clearEmailFromChat } from "../google/accounts.js";

registerJobHandler("system.quiet_digest", async (db) => void (await sendQuietDigest(db)));
registerJobHandler("system.scheduled_actions", async (db) => void (await runScheduledActions(db)));
registerJobHandler("system.backup", async (db) => {
  // Each nightly backup is test-restored straight away, so the recovery check always reflects the newest file.
  if (await makeBackup(db)) runRestoreCheck(db);
});
registerJobHandler("system.housekeeping", (db) => {
  pruneNotifications(db);
  pruneBackups();
  // Email headers shown in chat are kept for 30 days at most.
  clearEmailFromChat(db, (_g, createdAt) => Date.parse(createdAt) < Date.now() - 30 * 86_400_000);
});

/** Seeds the built-in jobs (idempotent: ids are fixed, schedules kept unless changed here). */
export function seedSystemJobs(db: DB) {
  upsertJob(db, { id: "sys_quiet_digest", kind: "system.quiet_digest", name: "Quiet-hours summary", schedule: { type: "interval", minutes: 15 }, system: true, catchUp: "skip" });
  upsertJob(db, { id: "sys_scheduled_actions", kind: "system.scheduled_actions", name: "Run scheduled approved actions", schedule: { type: "interval", minutes: 1 }, system: true, catchUp: "once" });
  upsertJob(db, { id: "sys_backup", kind: "system.backup", name: "Nightly encrypted backup", schedule: { type: "daily", time: "02:30" }, system: true, catchUp: "once" });
  upsertJob(db, { id: "sys_housekeeping", kind: "system.housekeeping", name: "Tidy old notifications and backups", schedule: { type: "daily", time: "03:30" }, system: true, catchUp: "once" });
}

/** Runs once when the server starts (and in tests). Safe to run repeatedly. */
export async function bootstrapSystem(db: DB) {
  seedSpaces(db);
  const v = vaultStatus();
  if (v.problem) console.error(`[security] ${v.problem}`);
  const r = protectStoredSecrets(db);
  if (r.sealed || r.rewrapped) logActivity(db, "system", "secrets.protected", null, { count: r.sealed + r.rewrapped });
  recoverJobs(db);
  await recoverActions(db);
  seedSystemJobs(db);
  ensureExampleAgent(db);
  meteringSince(db); // records when Nikki's own AI measurement began (no history is back-filled)
}
