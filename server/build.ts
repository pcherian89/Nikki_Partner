import fs from "node:fs";
import path from "node:path";

let cached: string | null | undefined;

/**
 * Identifies the frontend build being served: the hashed name of its main script in dist/index.html.
 * The app compares it with the script it is running, so a home-screen copy kept in memory by the phone
 * reloads itself after an update. Null in development (no build).
 */
export function currentBuildId(): string | null {
  if (cached !== undefined) return cached;
  try {
    const html = fs.readFileSync(path.resolve("dist", "index.html"), "utf8");
    cached = html.match(/\/assets\/[^"']+\.js/)?.[0] ?? null;
  } catch {
    cached = null;
  }
  return cached;
}
