/** mDNS service type advertised by hosting servers and browsed by clients. */
export const MDNS_SERVICE_TYPE = "slackoss";

export const DEFAULT_PORT = 8543;

/** TXT record payload attached to the mDNS advertisement. */
export interface DiscoveryTxt {
  name: string; // workspace name
  ver: string; // server version
  proto: string; // protocol version
  /**
   * The advertising server's instance id, new on every start and also served
   * by /api/health. What tells "this computer's own workspace" apart from
   * another one on the same port. Absent from servers before it was added.
   */
  inst?: string;
}

/**
 * `host:port` for building an address, with an IPv6 literal in brackets: the
 * only way a URL, or anything that reads one, can tell the port from the
 * address. A host already in brackets is left as it is.
 */
export function hostWithPort(host: string, port: number): string {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare.includes(":") ? `[${bare}]:${port}` : `${bare}:${port}`;
}

/**
 * Whether an address can be put in a link. An IPv6 link-local address
 * (fe80::/10) only works together with the network interface it belongs to,
 * and a browser's URL has no way to say which one, so it cannot.
 */
export function isLinkableAddress(host: string): boolean {
  if (!host) return false;
  if (host.includes("%")) return false;
  return !/^\[?fe[89ab][0-9a-f]:/i.test(host);
}

/** Deep-link format: gatherline://join?host=1.2.3.4:8543&code=INVITE */
export const GATHERLINE_DEEP_LINK_PROTOCOL = "gatherline";

/**
 * Previous deep-link scheme, still accepted everywhere links are read and
 * still registered with the OS so old invites keep opening the app.
 */
export const DEEP_LINK_PROTOCOL = "slackoss";

/** Every deep-link scheme the app reads, primary first. */
export const DEEP_LINK_PROTOCOLS = [GATHERLINE_DEEP_LINK_PROTOCOL, DEEP_LINK_PROTOCOL] as const;
