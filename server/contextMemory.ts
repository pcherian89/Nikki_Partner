import type { ContextSuggestion, Profile } from "../shared/types.js";
import { DB, getSetting, setSetting } from "./db.js";

/**
 * Keeps context suggestions from nagging: remembers every suggestion the user
 * saved or dismissed, and drops suggestions that add nothing new.
 */

const KEY = "context_decisions";
const MAX = 200;

export const normText = (s: string) => s.toLowerCase().replace(/[^a-z0-9:]+/g, " ").trim();

interface Decision {
  field: string;
  value: string;
  action: "saved" | "dismissed";
}

export function decisions(db: DB): Decision[] {
  try {
    return JSON.parse(getSetting(db, KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function recordDecision(db: DB, field: string, value: string, action: Decision["action"]) {
  const list = decisions(db).filter((d) => !(d.field === field && normText(d.value) === normText(value)));
  list.push({ field, value: value.slice(0, 1000), action });
  setSetting(db, KEY, JSON.stringify(list.slice(-MAX)));
}

/** Recently declined suggestions, so the model is told not to repeat them. */
export function declinedForModel(db: DB) {
  return decisions(db)
    .filter((d) => d.action === "dismissed")
    .slice(-10)
    .map((d) => ({ field: d.field, value: d.value.slice(0, 200) }));
}

/** Words in `value` that aren't already in `current`. */
function addsSomething(current: string, value: string) {
  const have = new Set(normText(current).split(" "));
  return normText(value)
    .split(" ")
    .some((w) => w.length > 2 && !have.has(w));
}

/**
 * Filters model suggestions: one per field, nothing identical to (or already
 * contained in) the saved value, nothing the user already saved or dismissed.
 */
export const LIST_FIELDS = new Set(["projects", "goals", "commitments", "preferences"]);

export function filterSuggestions(db: DB, profile: Profile, suggestions: ContextSuggestion[]): ContextSuggestion[] {
  const decided = decisions(db);
  const byField = new Map<string, ContextSuggestion>();
  for (const s of suggestions) {
    const current = (profile[s.field] ?? "").trim();
    const v = s.value.trim();
    if (!v) continue;
    if (s.action === "remove") {
      // Only offer removals of something actually saved; point at the exact saved line.
      const lines = LIST_FIELDS.has(s.field) ? current.split("\n").filter((l) => l.trim()) : current ? [current] : [];
      const nv = normText(v);
      const line = lines.find((l) => normText(l) === nv) ?? lines.find((l) => normText(l).includes(nv) || nv.includes(normText(l)));
      if (!line) continue;
      if (decided.some((d) => d.field === s.field && normText(d.value) === normText(`remove:${line}`))) continue;
      byField.set(`${s.field}:remove:${line}`, { ...s, value: line.trim(), current: current || undefined });
      continue;
    }
    if (normText(v) === normText(current)) continue;
    // List fields only ever get new lines added: skip anything already covered.
    if (LIST_FIELDS.has(s.field) && current && !addsSomething(current, v)) continue;
    if (decided.some((d) => d.field === s.field && normText(d.value) === normText(v))) continue;
    byField.set(s.field, { ...s, action: LIST_FIELDS.has(s.field) ? "add" : "set", current: current || undefined });
  }
  return [...byField.values()];
}
