/** mDNS service type advertised by hosting servers and browsed by clients. */
export const MDNS_SERVICE_TYPE = "slackoss";

export const DEFAULT_PORT = 8543;

/** TXT record payload attached to the mDNS advertisement. */
export interface DiscoveryTxt {
  name: string; // workspace name
  ver: string; // server version
  proto: string; // protocol version
}

/** Deep-link format: slackoss://join?host=1.2.3.4:8543&code=INVITE */
export const DEEP_LINK_PROTOCOL = "slackoss";
