/** mDNS service type advertised by hosting servers and browsed by clients. */
export const MDNS_SERVICE_TYPE = "slackoss";

export const DEFAULT_PORT = 8543;

/** TXT record payload attached to the mDNS advertisement. */
export interface DiscoveryTxt {
  name: string; // workspace name
  ver: string; // server version
  proto: string; // protocol version
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
