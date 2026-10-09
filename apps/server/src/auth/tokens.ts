import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const ACCESS_TTL = "15m";
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const key = (secret: string) => new TextEncoder().encode(secret);

export function signAccessToken(userId: string, secret: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(key(secret));
}

/** Returns the user id, or null when the token is invalid or expired. */
export async function verifyAccessToken(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"] });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

export const newRefreshToken = () => randomBytes(32).toString("base64url");

// ponytail: plain SHA-256 is fine because the token is 256 bits of randomness (no brute force)
export const hashRefreshToken = (token: string) => createHash("sha256").update(token).digest("hex");
