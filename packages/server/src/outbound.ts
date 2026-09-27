import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Outbound HTTP for integrations.
 *
 * Slash commands and event subscriptions make the *server* call an address an
 * admin typed. On a self-hosted box that server usually sits inside the same
 * LAN as a router admin page, a NAS, a hypervisor, or a cloud metadata
 * endpoint — so an unguarded fetch here turns "workspace admin" into "can
 * probe the host's private network" (SSRF). Every address is therefore checked
 * against the private ranges before we connect, and the check runs inside the
 * socket's own DNS lookup so a name that resolves to a public address once and
 * a private one a moment later (DNS rebinding) still cannot get through.
 *
 * LAN-hosted bots are a legitimate thing to want in a LAN-first product, so
 * the block is a default, not a law: `--allow-private-hooks` turns it off.
 */

class OutboundError extends Error {
  constructor(
    public code: "blocked_host" | "unreachable" | "timeout" | "too_large" | "aborted",
    message: string,
  ) {
    super(message);
  }
}

export { OutboundError };

function ipv4IsPrivate(b: number[]): boolean {
  const [a, second] = b as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && second === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && second >= 16 && second <= 31) return true;
  if (a === 192 && second === 168) return true;
  if (a === 100 && second >= 64 && second <= 127) return true; // carrier NAT
  if (a === 192 && second === 0) return true; // IETF protocol assignments
  if (a === 198 && (second === 18 || second === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => Number(p));
  if (bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return bytes;
}

/** True for anything we refuse to let an admin-supplied URL reach. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return ipv4IsPrivate(v4);

  const addr = ip.toLowerCase().split("%")[0]!; // drop any zone index
  // IPv4-mapped and IPv4-compatible forms hide a v4 address inside a v6 one.
  const embedded = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (embedded) {
    const bytes = parseIpv4(embedded[1]!);
    return bytes ? ipv4IsPrivate(bytes) : true;
  }
  if (addr === "::" || addr === "::1") return true;
  const head = addr.split(":")[0] ?? "";
  if (head.length === 0) return true; // unexpected shape; refuse rather than guess
  const group = Number.parseInt(head.padStart(4, "0").slice(0, 4), 16);
  if (Number.isNaN(group)) return true;
  if ((group & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((group & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((group & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export interface OutboundOptions {
  /** Skips the private-range check. Set by --allow-private-hooks. */
  allowPrivate?: boolean;
  timeoutMs?: number;
  /** Response bytes read before we give up; replies are meant to be small. */
  maxBytes?: number;
  headers?: Record<string, string>;
  /**
   * Ends the call early. The server aborts every outbound call when it shuts
   * down, so an app that is slow to answer cannot hold the process open for
   * the whole of its timeout.
   */
  signal?: AbortSignal;
}

export interface OutboundResponse {
  status: number;
  body: string;
  contentType: string;
}

/**
 * POSTs a body and returns the (small) response. Redirects are not followed:
 * a redirect is exactly how a vetted public host would hand us a private one.
 */
export function postToUrl(
  url: string,
  body: string,
  contentType: string,
  opts: OutboundOptions = {},
): Promise<OutboundResponse> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const maxBytes = opts.maxBytes ?? 64 * 1024;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new OutboundError("blocked_host", "not a valid URL"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Promise.reject(new OutboundError("blocked_host", "only http(s) URLs are allowed"));
  }

  // A URL that already names an address never goes through DNS, so `lookup`
  // below would not see it. Check the literal here or "http://127.0.0.1" walks
  // straight past the guard.
  const literal = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!opts.allowPrivate && isIP(literal) !== 0 && isPrivateAddress(literal)) {
    return Promise.reject(
      new OutboundError(
        "blocked_host",
        `${literal} is a private address; start the server with --allow-private-hooks to allow this`,
      ),
    );
  }

  if (opts.signal?.aborted) {
    return Promise.reject(new OutboundError("aborted", "the server is shutting down"));
  }

  return new Promise<OutboundResponse>((resolve, reject) => {
    const payload = Buffer.from(body, "utf8");
    const request = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let release = () => {};
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      release();
      fn();
    };

    const req = request(
      parsed,
      {
        method: "POST",
        headers: {
          "content-type": contentType,
          "content-length": String(payload.byteLength),
          "user-agent": "SlackOSS",
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
          ...opts.headers,
        },
        // Runs for the address the socket is about to use, so there is no gap
        // between "we checked it" and "we connected to it".
        lookup: (hostname, options, callback) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cb = callback as any;
          dnsLookup(hostname, options, (err, address, family) => {
            if (err) return cb(err);
            const addresses = Array.isArray(address) ? address : [{ address, family }];
            if (!opts.allowPrivate) {
              for (const a of addresses) {
                if (isPrivateAddress(a.address)) {
                  return cb(
                    new OutboundError(
                      "blocked_host",
                      `${hostname} resolves to the private address ${a.address}; ` +
                        "start the server with --allow-private-hooks to allow this",
                    ),
                  );
                }
              }
            }
            return Array.isArray(address) ? cb(null, addresses) : cb(null, address, family);
          });
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxBytes) {
            finish(() => {
              res.destroy();
              reject(new OutboundError("too_large", "response body too large"));
            });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
              contentType: String(res.headers["content-type"] ?? ""),
            }),
          ),
        );
        res.on("error", (err) => finish(() => reject(err)));
      },
    );

    const onAbort = () => {
      finish(() => {
        req.destroy();
        reject(new OutboundError("aborted", "the server is shutting down"));
      });
    };
    // A long-lived shutdown signal must not retain a listener for each call.
    release = () => opts.signal?.removeEventListener("abort", onAbort);

    req.setTimeout(timeoutMs, () => {
      finish(() => {
        req.destroy();
        reject(new OutboundError("timeout", "the endpoint did not answer in time"));
      });
    });
    req.on("error", (err) =>
      finish(() =>
        reject(
          err instanceof OutboundError
            ? err
            : new OutboundError("unreachable", (err as Error).message),
        ),
      ),
    );

    // Socket timeout only detects inactivity. A streaming endpoint can keep
    // sending bytes forever, so cap the entire DNS/connect/write/read call.
    deadline = setTimeout(() => {
      finish(() => {
        req.destroy();
        reject(new OutboundError("timeout", "the endpoint did not answer in time"));
      });
    }, timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    req.end(payload);
  });
}
