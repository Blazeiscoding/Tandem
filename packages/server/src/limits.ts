/**
 * How often one caller may do one kind of thing.
 *
 * `burst` is what someone can do at once after sitting idle — opening the app
 * fires a handful of requests together, and a limit that forbade that would be
 * a bug rather than a defence. `perMinute` is the rate it refills at, which is
 * what actually bounds sustained abuse.
 */
export interface LimitRule {
  burst: number;
  perMinute: number;
}

/** Everything this server rations, and what it keys each one on. */
export interface Limits {
  /**
   * Failed sign-in and password attempts against one handle. Tight, because
   * this is the one an attacker repeats: guessing a password is the whole
   * point. Only wrong guesses count, so someone who knows their own password
   * never meets this however often they sign in.
   */
  authByHandle: LimitRule;
  /**
   * Sign-in attempts from one address. Deliberately loose. A workspace on an
   * office LAN reaches the server from a single NAT address, so everyone
   * arriving at nine o'clock shares this budget; tightening it would lock out
   * the whole company to slow one attacker who can simply use another address.
   * The per-handle limit above is what actually protects an account.
   */
  authByAddress: LimitRule;
  /**
   * Messages one account may send. The burst has to cover an outbox emptying
   * itself after someone has been offline, which is a legitimate rush of
   * writes that must not come back as a failed send.
   */
  post: LimitRule;
  /** Uploads one account may start. Generous enough to drop a folder in at once. */
  upload: LimitRule;
  /** Sockets one address may open. Loose, for the same NAT reason. */
  socket: LimitRule;
  /** Typing notices and call signalling from one account. */
  ephemeral: LimitRule;
}

export const DEFAULT_LIMITS: Limits = {
  authByHandle: { burst: 5, perMinute: 5 },
  authByAddress: { burst: 40, perMinute: 60 },
  post: { burst: 60, perMinute: 120 },
  upload: { burst: 20, perMinute: 60 },
  socket: { burst: 30, perMinute: 60 },
  ephemeral: { burst: 60, perMinute: 300 },
};

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * A token bucket per caller, held in memory.
 *
 * In memory rather than in the database because the cost of forgetting is one
 * extra burst after a restart, which is not worth a write on every request.
 * A full bucket is indistinguishable from one that never existed, so entries
 * are dropped once they refill and the map stays proportional to who is
 * actually active rather than to everyone who has ever connected.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(readonly limits: Limits = DEFAULT_LIMITS) {}

  /**
   * Spends one unit against `key`, or reports how long until it could succeed.
   * Nothing is spent when the answer is no, so a caller being refused does not
   * push its own recovery further away.
   */
  take(name: keyof Limits, key: string, now = Date.now()): { ok: boolean; retryAfterMs: number } {
    const rule = this.limits[name];
    const id = `${name}:${key}`;
    const refillPerMs = rule.perMinute / 60_000;
    const existing = this.buckets.get(id);
    const tokens = existing
      ? Math.min(rule.burst, existing.tokens + (now - existing.updatedAt) * refillPerMs)
      : rule.burst;

    if (tokens < 1) {
      this.buckets.set(id, { tokens, updatedAt: now });
      return { ok: false, retryAfterMs: Math.ceil((1 - tokens) / refillPerMs) };
    }

    const left = tokens - 1;
    if (left >= rule.burst) this.buckets.delete(id);
    else this.buckets.set(id, { tokens: left, updatedAt: now });
    this.sweep(now);
    return { ok: true, retryAfterMs: 0 };
  }

  /**
   * Wipes what a key has spent. Used when an attempt turns out to have been
   * legitimate after all, which is what keeps a guessing limit off the backs of
   * the people who are not guessing.
   */
  forget(name: keyof Limits, key: string): void {
    this.buckets.delete(`${name}:${key}`);
  }

  /** Live buckets, so a test can prove this does not grow without end. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Drops buckets that have refilled. Only every few seconds: doing it on every
   * request would make each one cost the size of the whole map.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 10_000) return;
    this.lastSweep = now;
    for (const [id, bucket] of this.buckets) {
      const name = id.slice(0, id.indexOf(":")) as keyof Limits;
      const rule = this.limits[name];
      if (!rule) {
        this.buckets.delete(id);
        continue;
      }
      const tokens = bucket.tokens + (now - bucket.updatedAt) * (rule.perMinute / 60_000);
      if (tokens >= rule.burst) this.buckets.delete(id);
    }
  }
}
