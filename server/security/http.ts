import { createHash } from "node:crypto";
import fs from "node:fs";
import type { NextFunction, Request, Response } from "express";

/**
 * Browser-side protections.
 *
 * - Security headers on every response, including a Content Security Policy that only allows Nikki's own scripts
 *   (plus the one inline theme script, allowed by its hash) and Google Fonts. This blocks injected scripts even if
 *   some text were ever rendered unsafely.
 * - CSRF: the session cookie is SameSite=Strict, and on top of that every state-changing /api request must come from
 *   Nikki's own page (Origin / Sec-Fetch-Site checked). Requests with neither header (curl, server-to-server) are
 *   allowed: they can't carry the user's cookie from another site.
 */

let inlineHashes: string[] = [];

/** Hashes the inline <script> blocks of the built page so the CSP can allow exactly those. */
export function loadInlineScriptHashes(indexHtmlPath: string) {
  try {
    const html = fs.readFileSync(indexHtmlPath, "utf8");
    inlineHashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      (m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`,
    );
  } catch {
    inlineHashes = [];
  }
}

export function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineHashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", contentSecurityPolicy());
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export function sameOriginOnly(req: Request, res: Response, next: NextFunction) {
  if (SAFE.has(req.method) || !req.path.startsWith("/api/")) return next();
  const site = req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return refuse(res);
  const origin = req.header("origin");
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return refuse(res);
    }
    if (host !== req.header("host") && host !== req.header("x-forwarded-host")) return refuse(res);
  }
  next();
}

function refuse(res: Response) {
  res.status(403).json({ error: "This request didn't come from Nikki's own page, so it was refused.", code: "cross_site" });
}
