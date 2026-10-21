import "dotenv/config";
import path from "node:path";

export const DEFAULT_MODEL = "claude-opus-5-5";

const hosted = process.env.PUBLIC_DEPLOYMENT === "true" || !!process.env.RAILWAY_ENVIRONMENT;
// Railway tells the app where its permanent volume is mounted. Anything outside it is wiped on every deploy,
// so the database always goes inside the volume when there is one.
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH) : null;
const requested = path.resolve(process.env.DATABASE_PATH || "./data/nikki.db");
const insideVolume = (p: string) => !!volume && (p === volume || p.startsWith(volume + path.sep));
const databasePath = volume && !insideVolume(requested) ? path.join(volume, path.basename(requested) || "nikki.db") : requested;

/** Null when storage is permanent; otherwise a plain-language warning shown in the app and the logs. */
const storageWarning =
  hosted && !volume
    ? "Your data isn't on permanent storage, so it will be lost the next time the app updates. In Railway, add a Volume to this service (mount path /data)."
    : null;

export const config = {
  apiKey: (process.env.ANTHROPIC_API_KEY || "").trim(),
  model: (process.env.ANTHROPIC_MODEL || "").trim() || DEFAULT_MODEL,
  databasePath,
  storageWarning,
  movedIntoVolume: volume && !insideVolume(requested) ? requested : null,
  demoDatabasePath: path.join(path.dirname(databasePath), "nikki-demo.db"),
  port: Number(process.env.PORT) || 3001,
  appPassword: process.env.APP_PASSWORD || "",
  /** Set on hosted deployments (auto-detected on Railway): the app refuses to start without a strong password. */
  publicDeployment: hosted,
  isProduction: process.env.NODE_ENV === "production",
};

export const liveAvailable = () => config.apiKey.length > 0;
