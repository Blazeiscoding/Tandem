/**
 * What the server may believe about where a request came from.
 *
 * A `Host` header is written by whoever made the request, and so are all the
 * `X-Forwarded-*` headers. They are useful when a reverse proxy in front of
 * this server sets them and nothing else can, and worthless otherwise, because
 * anyone can send them. The functions here are the parts of that judgement that
 * do not need a live request, so they can be tested on their own.
 */

/**
 * Where this server is, according to the connection the request arrived on.
 *
 * This is the socket's own local address and port, which the client cannot
 * change by sending a different header. On a machine serving a LAN it is the
 * interface the client actually reached, which is the useful answer as well as
 * the safe one.
 */
export function originFromConnection(
  address: string | undefined,
  port: number | undefined,
): string {
  const host = (address ?? "127.0.0.1").replace(/^::ffff:/, "");
  // A bare IPv6 address has to be bracketed before it can sit in a URL.
  const authority = host.includes(":") ? `[${host}]` : host;
  return port ? `http://${authority}:${port}` : `http://${authority}`;
}

/**
 * Whether an `Origin` header names this same server on the loopback interface.
 *
 * This is what separates a person's own machine from a web page that person is
 * merely visiting. A command line request carries no `Origin` at all; a browser
 * always sends one on a write, and a page served from anywhere else names that
 * somewhere else. Both the host and the port have to match, so another service
 * on the same machine does not count as this one.
 */
export function isLoopbackOrigin(origin: string, port: number | undefined): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/^::ffff:/, "");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return false;
  const originPort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return originPort === port;
}

/** The first value of a header a proxy may have appended to. */
export function firstHeaderValue(raw: string | string[] | undefined): string {
  return (
    String(raw ?? "")
      .split(",")[0]
      ?.trim() ?? ""
  );
}
