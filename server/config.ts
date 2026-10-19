import "dotenv/config";
import path from "node:path";

export const DEFAULT_MODEL = "claude-opus-5-5";

const databasePath = path.resolve(process.env.DATABASE_PATH || "./data/nikki.db");

export const config = {
  apiKey: (process.env.ANTHROPIC_API_KEY || "").trim(),
  model: (process.env.ANTHROPIC_MODEL || "").trim() || DEFAULT_MODEL,
  databasePath,
  demoDatabasePath: path.join(path.dirname(databasePath), "nikki-demo.db"),
  port: Number(process.env.PORT) || 3001,
  appPassword: process.env.APP_PASSWORD || "",
  /** Set on hosted deployments (auto-detected on Railway): the app refuses to start without a strong password. */
  publicDeployment: process.env.PUBLIC_DEPLOYMENT === "true" || !!process.env.RAILWAY_ENVIRONMENT,
  isProduction: process.env.NODE_ENV === "production",
};

export const liveAvailable = () => config.apiKey.length > 0;
