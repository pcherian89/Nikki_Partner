import { config } from "../config.js";

/**
 * Google connection settings (Stage 1A: read-only Gmail and Calendar through Google's official MCP servers).
 *
 * - Credentials come only from the server environment: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (an OAuth client
 *   created in Google Cloud with "Use this client for an AI-powered agent" ticked). Never from the app or chat.
 * - The redirect address is PUBLIC_URL (or Railway's own public domain) + /oauth/google/callback. It must match the
 *   "Authorised redirect URI" entered in Google Cloud exactly.
 * - Scopes are the smallest that cover the read tools Nikki uses (checked against Google's per-tool pages,
 *   28 Nov 2026): gmail.readonly and calendar.readonly, plus openid/email/profile to confirm which account signed in.
 *   Drafting and sending (Stages 1B and 1D) will ask for more only when those features are ready and approved.
 */

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

export const SCOPE_GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const SCOPE_CALENDAR_READ = "https://www.googleapis.com/auth/calendar.readonly";

/** Google's endpoints. Overridable only in tests (GOOGLE_TEST_BASE) so tests never reach Google. */
// Never on a hosted deployment (Railway or PUBLIC_DEPLOYMENT), whatever else is set: production only talks to Google.
const hostedDeployment = () => process.env.PUBLIC_DEPLOYMENT === "true" || !!process.env.RAILWAY_ENVIRONMENT;
const testBase = () => (!hostedDeployment() && (process.env.NODE_ENV === "test" || process.env.NIKKI_TEST === "1") ? process.env.GOOGLE_TEST_BASE : undefined);
export const endpoints = () => {
  const t = testBase();
  return {
    authorize: t ? `${t}/o/oauth2/v2/auth` : "https://accounts.google.com/o/oauth2/v2/auth",
    token: t ? `${t}/token` : "https://oauth2.googleapis.com/token",
    revoke: t ? `${t}/revoke` : "https://oauth2.googleapis.com/revoke",
    // Self-mode toolsets: they leave out the tools that always need an interactive approval (send, reply, forward,
    // delete event). Nikki only ever calls the read tools listed in mcp.ts, whatever the server offers.
    gmailMcp: t ? `${t}/gmail/mcp/v1self` : "https://gmailmcp.googleapis.com/mcp/v1self",
    calendarMcp: t ? `${t}/calendar/mcp/v1self` : "https://calendarmcp.googleapis.com/mcp/v1self",
  };
};

export function publicUrl(): string {
  const explicit = (process.env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN ?? "").trim();
  if (railway) return `https://${railway}`;
  return `http://localhost:${config.port}`;
}

export const redirectUri = () => `${publicUrl()}/oauth/google/callback`;

export function googleSetup() {
  const id = (process.env.GOOGLE_CLIENT_ID ?? "").trim();
  const secret = (process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
  const problems: string[] = [];
  if (!id) problems.push("GOOGLE_CLIENT_ID is not set on the server.");
  else if (!/\.apps\.googleusercontent\.com$/.test(id)) problems.push("GOOGLE_CLIENT_ID doesn't look like a Google client ID (it ends in .apps.googleusercontent.com).");
  if (!secret) problems.push("GOOGLE_CLIENT_SECRET is not set on the server.");
  return { configured: problems.length === 0, clientId: id, clientSecret: secret, redirectUri: redirectUri(), problems };
}

/** Internal daily ceilings per product, well under Google's free Standard tier (5,000 requests a day per project). */
export const DAILY_CALL_LIMIT = 1500;
