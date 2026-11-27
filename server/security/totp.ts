import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 6238 time-based one-time passwords (the 6-digit codes from Apple Passwords, Google Authenticator, 1Password…). No dependency. */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("Invalid base32.");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpAt(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const off = mac[mac.length - 1] & 15;
  const code = ((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  return code;
}

export const counterAt = (ms: number) => Math.floor(ms / 30_000);

/** Returns the matching counter (±1 step for clock drift), or null. The caller rejects a counter already used. */
export function verifyTotp(secret: string, code: string, nowMs: number): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const now = counterAt(nowMs);
  for (const n of [now, now - 1, now + 1]) {
    if (timingSafeEqual(Buffer.from(totpAt(secret, n)), Buffer.from(c))) return n;
  }
  return null;
}

export const otpauthUri = (secret: string, label = "Nikki") =>
  `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent("Nikki")}&algorithm=SHA1&digits=6&period=30`;

/** Eight one-use recovery codes like "k7m2-9qpd". */
export const newRecoveryCodes = () =>
  Array.from({ length: 8 }, () => {
    const s = base32Encode(randomBytes(5)).toLowerCase();
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
