import { UserFacingError } from "./assistant.js";
import { DB, TABLES } from "./db.js";

/**
 * Restores a workspace from a file made with "Export my data". Replaces
 * everything in the workspace, in one transaction (all or nothing).
 */
const IMPORTABLE = TABLES.filter((t) => t !== "requests");
const JSON_COLUMNS = new Set(["data", "meta"]);

export function importWorkspace(db: DB, data: Record<string, unknown>) {
  if (!Array.isArray(data.tasks) || !("profile" in data)) {
    throw new UserFacingError("That file doesn't look like a Nikki export.", 400, "invalid_import");
  }
  db.transaction(() => {
    for (const table of IMPORTABLE) {
      const rows = data[table];
      if (rows !== undefined && !Array.isArray(rows)) throw new UserFacingError(`"${table}" in the file is not a list.`, 400, "invalid_import");
      const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      db.prepare(`DELETE FROM ${table}`).run();
      for (const raw of (rows as Record<string, unknown>[] | undefined) ?? []) {
        if (!raw || typeof raw !== "object") continue;
        const entries = Object.entries(raw)
          .filter(([k]) => columns.has(k) && k !== "seq")
          .map(([k, v]) => [k, JSON_COLUMNS.has(k) && typeof v === "object" && v !== null ? JSON.stringify(v) : v] as const);
        if (!entries.length) continue;
        const cols = entries.map(([k]) => k);
        db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
          ...entries.map(([, v]) => (typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null))),
        );
      }
    }
  })();
}
