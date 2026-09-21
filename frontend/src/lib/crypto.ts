import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** Random URL-safe string, for session tokens and OAuth state. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// One key per purpose (signing vs encrypting), both derived from AUTH_SECRET.
function key(purpose: "sign" | "encrypt"): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET is missing or shorter than 32 characters - see .env.example");
  }
  return Buffer.from(hkdfSync("sha256", secret, "averis-auth", purpose, 32));
}

/** value -> "value.signature", so a cookie can't be forged or altered. */
export function sign(value: string): string {
  return `${value}.${createHmac("sha256", key("sign")).update(value).digest("base64url")}`;
}

/** The original value if the signature is valid, otherwise null. */
export function unsign(signed: string): string | null {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  return safeEqual(sign(value), signed) ? value : null;
}

/** AES-256-GCM: for secrets we must be able to read back later (Google refresh tokens). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("encrypt"), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt(payload: string): string {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("unrecognised encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key("encrypt"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
