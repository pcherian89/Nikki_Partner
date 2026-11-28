import { lookup } from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";

/**
 * Outbound fetches of user-supplied URLs (calendar links) must not reach the server's own network: localhost, the
 * Railway private network, cloud metadata addresses or LAN ranges. Every redirect hop is checked again.
 *
 * On a hosted deployment private addresses are always refused. On a laptop (not hosted) they are allowed, so a
 * calendar served on the local network still works and the existing tests can use a local server.
 *
 * Known limit: the address is checked before connecting, so a hostile DNS server could in theory answer
 * differently a moment later (DNS rebinding). Calendar sync only reads text, sends no secrets and never returns the
 * raw body to the browser, which limits what such an attack could learn.
 */

const BLOCKED_HOST = /(^|\.)(localhost|internal|local|localdomain|home\.arpa)$/i;

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v) || v.startsWith("64:ff9b:") || v.startsWith("2001:db8");
  }
  return true;
}

export class BlockedUrlError extends Error {}

export async function assertPublicUrl(raw: string, allowPrivate = !config.publicDeployment) {
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new BlockedUrlError("Only web (http/https) links are allowed.");
  if (u.username || u.password) throw new BlockedUrlError("Links with a user name or password in them are not allowed.");
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOST.test(host)) throw new BlockedUrlError("That address points inside a private network, so Nikki won't fetch it.");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new BlockedUrlError("That address points inside a private network, so Nikki won't fetch it.");
  return u;
}

/** fetch() for user-supplied URLs: every hop checked, at most 5 redirects, no cookies or credentials sent. */
export async function safeFetch(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: "manual", credentials: "omit" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    return res;
  }
  throw new BlockedUrlError("The link redirected too many times.");
}
