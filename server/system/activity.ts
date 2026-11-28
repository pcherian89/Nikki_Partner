import { clockIso, type DB } from "../db.js";

/**
 * Append-only record of what happened (sign-ins, approvals, executions, budget events, emergency stops). It stores
 * ids, kinds and short non-sensitive facts only, never message bodies, email content or secrets. The table has
 * triggers that refuse UPDATE and DELETE.
 */
export type Actor = "user" | "system" | `agent:${string}` | `job:${string}`;

export interface ActivityEntry {
  seq: number;
  at: string;
  actor: string;
  kind: string;
  subject: string | null;
  spaceId: string | null;
  detail: Record<string, unknown>;
}

const SAFE_DETAIL = /^(id|ids|count|status|from|to|reason|level|kind|model|workflow|amount|percent|label|device|session|job|agent|action|space|code|attempt|result)$/;

export function logActivity(db: DB, actor: Actor, kind: string, subject: string | null = null, detail: Record<string, unknown> = {}, spaceId: string | null = null) {
  // Only whitelisted keys, and short scalar values, so the log can never become a copy of private content.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (!SAFE_DETAIL.test(k)) continue;
    if (typeof v === "string") clean[k] = v.slice(0, 120);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) clean[k] = v;
    else if (Array.isArray(v)) clean[k] = v.slice(0, 20).map((x) => String(x).slice(0, 60));
  }
  db.prepare("INSERT INTO activity_log (at, actor, kind, subject, space_id, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
    clockIso(),
    actor,
    kind,
    subject,
    spaceId,
    JSON.stringify(clean),
  );
}

export function listActivity(db: DB, limit = 100, beforeSeq?: number): ActivityEntry[] {
  const rows = (
    beforeSeq
      ? db.prepare("SELECT * FROM activity_log WHERE seq < ? ORDER BY seq DESC LIMIT ?").all(beforeSeq, limit)
      : db.prepare("SELECT * FROM activity_log ORDER BY seq DESC LIMIT ?").all(limit)
  ) as { seq: number; at: string; actor: string; kind: string; subject: string | null; space_id: string | null; detail: string }[];
  return rows.map((r) => ({ seq: r.seq, at: r.at, actor: r.actor, kind: r.kind, subject: r.subject, spaceId: r.space_id, detail: JSON.parse(r.detail) }));
}
