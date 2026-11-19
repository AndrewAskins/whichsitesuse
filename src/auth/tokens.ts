import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A random URL-safe token with `bytes` of entropy, in base62. */
export function randomToken(bytes = 24): string {
  const buf = randomBytes(bytes);
  let out = "";
  for (const b of buf) out += BASE62[b % 62];
  // b % 62 is slightly biased; extra length makes up for it.
  for (const b of randomBytes(Math.ceil(bytes / 4))) out += BASE62[b % 62];
  return out;
}

/** SHA-256 hex, for storing tokens and keys we only ever compare. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** A signed, expiring payload: base64url(JSON).signature. */
export function signPayload(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(secret, body)}`;
}

export function verifyPayload<T extends { exp: number }>(secret: string, token: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEqual(sig, hmac(secret, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}
