import { Bonjour } from "bonjour-service";
import { MDNS_SERVICE_TYPE, PROTOCOL_VERSION } from "@slackoss/protocol";
import { SERVER_VERSION } from "./server.js";

export interface MdnsHandle {
  stop: () => void;
}

/** Advertise this workspace on the local network so clients can list it on the Join screen. */
export function advertise(opts: { name: string; port: number }): MdnsHandle {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: `${opts.name} (SlackOSS)`,
    type: MDNS_SERVICE_TYPE,
    port: opts.port,
    txt: {
      name: opts.name,
      ver: SERVER_VERSION,
      proto: String(PROTOCOL_VERSION),
    },
  });
  return {
    stop: () => {
      service.stop?.();
      bonjour.destroy();
    },
  };
}
