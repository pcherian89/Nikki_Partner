import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for secrets at rest (OAuth tokens, API keys, push signing keys, 2FA secrets, backups).
 *
 * - AES-256-GCM with a random 96-bit IV per value; the GCM tag detects any tampering.
 * - The key lives ONLY in the server environment (`NIKKI_ENCRYPTION_KEY`, 32 random bytes as base64), never in the
 *   database, the repository, the browser or logs.
 * - Rotation: set the new key as `NIKKI_ENCRYPTION_KEY` and the old one as `NIKKI_ENCRYPTION_KEY_PREVIOUS`. Values
 *   sealed with either key open; `rewrapAll` re-seals everything with the new key, after which the old one can go.
 * - Every sealed value carries the key's short id, so the right key is chosen and a wrong key fails loudly.
 * - `aad` (additional authenticated data) binds a value to where it is stored (for example "secret:vapid_private"),
 *   so a sealed value copied into another row will not open.
 */

const PREFIX = "enc:v1";

interface Key {
  id: string;
  bytes: Buffer;
}

function parseKey(raw: string | undefined): Key | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(v, "base64");
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return { id: createHash("sha256").update(bytes).digest("hex").slice(0, 8), bytes };
}

export interface VaultStatus {
  /** True when a valid current key is configured. */
  ready: boolean;
  /** Short, non-secret fingerprint of the current key (safe to show). */
  keyId: string | null;
  /** True when a previous key is configured for rotation. */
  rotating: boolean;
  /** A configured value that is not a valid 32-byte base64 key. */
  problem: string | null;
}

function keys() {
  const current = parseKey(process.env.NIKKI_ENCRYPTION_KEY);
  const previous = parseKey(process.env.NIKKI_ENCRYPTION_KEY_PREVIOUS);
  return { current, previous };
}

export function vaultStatus(): VaultStatus {
  const { current, previous } = keys();
  const raw = (process.env.NIKKI_ENCRYPTION_KEY ?? "").trim();
  return {
    ready: !!current,
    keyId: current?.id ?? null,
    rotating: !!previous,
    problem: raw && !current ? "NIKKI_ENCRYPTION_KEY is set but is not 32 random bytes in base64 (44 characters ending in =)." : null,
  };
}

export class VaultError extends Error {}

export const isSealed = (v: string | null | undefined): v is string => typeof v === "string" && v.startsWith(PREFIX + ":");

/** Encrypts a value. Throws if no key is configured: callers decide whether plaintext fallback is acceptable. */
export function seal(plaintext: string | Buffer, aad: string): string {
  const { current } = keys();
  if (!current) throw new VaultError("No encryption key is configured on the server (NIKKI_ENCRYPTION_KEY).");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", current.bytes, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), c.final()]);
  const tag = c.getAuthTag();
  return [PREFIX, current.id, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

function openRaw(sealed: string, aad: string): Buffer {
  const parts = sealed.split(":");
  if (parts.length !== 6 || `${parts[0]}:${parts[1]}` !== PREFIX) throw new VaultError("Not a sealed value.");
  const [, , keyId, iv, tag, ct] = parts;
  const { current, previous } = keys();
  const key = [current, previous].find((k) => k?.id === keyId);
  if (!key) throw new VaultError(`This value was encrypted with a key (${keyId}) that is not configured.`);
  try {
    const d = createDecipheriv("aes-256-gcm", key.bytes, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
  } catch {
    throw new VaultError("A stored secret failed its integrity check (wrong key or tampered value).");
  }
}

export const open = (sealed: string, aad: string): string => openRaw(sealed, aad).toString("utf8");
export const openBuffer = (sealed: string, aad: string): Buffer => openRaw(sealed, aad);

/** True when the value was sealed with the previous key and should be re-sealed. */
export function needsRewrap(sealed: string): boolean {
  const { current } = keys();
  return isSealed(sealed) && !!current && sealed.split(":")[2] !== current.id;
}

/** Binary helpers for whole files (backups): [12-byte IV][16-byte tag][ciphertext], key id in a small header. */
export function sealFile(data: Buffer, aad: string): Buffer {
  const { current } = keys();
  if (!current) throw new VaultError("No encryption key is configured on the server (NIKKI_ENCRYPTION_KEY).");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", current.bytes, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(data), c.final()]);
  const header = Buffer.from(`NIKKIENC1:${current.id}\n`, "utf8");
  return Buffer.concat([header, iv, c.getAuthTag(), ct]);
}

export function openFile(file: Buffer, aad: string): Buffer {
  const nl = file.indexOf(0x0a);
  const header = nl > 0 ? file.subarray(0, nl).toString("utf8") : "";
  const m = /^NIKKIENC1:([0-9a-f]{8})$/.exec(header);
  if (!m) throw new VaultError("Not a Nikki encrypted backup.");
  const { current, previous } = keys();
  const key = [current, previous].find((k) => k?.id === m[1]);
  if (!key) throw new VaultError(`This backup was encrypted with a key (${m[1]}) that is not configured.`);
  const body = file.subarray(nl + 1);
  const d = createDecipheriv("aes-256-gcm", key.bytes, body.subarray(0, 12));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(body.subarray(12, 28));
  try {
    return Buffer.concat([d.update(body.subarray(28)), d.final()]);
  } catch {
    throw new VaultError("The backup failed its integrity check (wrong key or damaged file).");
  }
}

/** A new random key, base64. Used by the key-generation script; never logged. */
export const generateKey = () => randomBytes(32).toString("base64");
