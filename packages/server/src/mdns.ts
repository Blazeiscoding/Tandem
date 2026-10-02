import { Bonjour } from "bonjour-service";
import { MDNS_SERVICE_TYPE, PROTOCOL_VERSION, type DiscoveryTxt } from "@slackoss/protocol";
import { SERVER_VERSION } from "./version.js";

export interface MdnsHandle {
  stop: () => void;
}

/** Advertise this workspace on the local network so clients can list it on the Join screen. */
export function advertise(opts: { name: string; port: number; instanceId: string }): MdnsHandle {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: `${opts.name} (SlackOSS)`,
    type: MDNS_SERVICE_TYPE,
    port: opts.port,
    txt: {
      name: opts.name,
      ver: SERVER_VERSION,
      proto: String(PROTOCOL_VERSION),
      inst: opts.instanceId,
    } satisfies DiscoveryTxt,
  });
  return {
    stop: () => {
      service.stop?.();
      bonjour.destroy();
    },
  };
}
