import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await derive(password, salt)).toString("hex");
  return { hash, salt };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = await derive(password, salt);
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
