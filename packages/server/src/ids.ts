import { randomBytes } from "node:crypto";

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Compact ULID: 10-char Crockford-base32 timestamp + 16 random chars. Lexicographically time-sortable. */
export function ulid(now = Date.now()): string {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ENC[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let rs = "";
  for (let i = 0; i < 16; i++) rs += ENC[rand[i]! % 32];
  return ts + rs;
}

export function inviteCode(): string {
  const rand = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ENC[rand[i]! % 32];
  return out;
}

/** Long random secret for bot tokens and webhook URLs. */
export function secretToken(prefix = ""): string {
  return prefix + randomBytes(24).toString("hex");
}
