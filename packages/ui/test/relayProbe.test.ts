import { describe, expect, it, vi } from "vitest";
import { probeRelay } from "../src/lib/relayProbe.js";

/**
 * A connection that, once it has an offer, reports the routes and errors a
 * relay would give it, in order.
 */
function fakeConnection(events: ({ candidate: string | null } | { errorCode: number })[]) {
  const configs: RTCConfiguration[] = [];
  let closed = false;
  const connect = (config: RTCConfiguration) => {
    configs.push(config);
    const target = new EventTarget();
    return Object.assign(target, {
      createDataChannel: vi.fn(),
      createOffer: vi.fn(async () => ({ type: "offer", sdp: "" })),
      setLocalDescription: vi.fn(async () => {
        setTimeout(() => {
          for (const event of events) {
            if ("errorCode" in event)
              target.dispatchEvent(Object.assign(new Event("icecandidateerror"), event));
            else
              target.dispatchEvent(
                Object.assign(new Event("icecandidate"), {
                  candidate:
                    event.candidate === null
                      ? null
                      : { candidate: event.candidate, type: event.candidate.split(" ")[7] },
                }),
              );
          }
        });
      }),
      close: () => {
        closed = true;
      },
    }) as unknown as RTCPeerConnection;
  };
  return { connect, configs, closed: () => closed };
}

const relayed = "candidate:1 1 udp 41885439 104.30.1.1 50000 typ relay raddr 0.0.0.0 rport 0";
const servers = [{ urls: "turn:relay.example.org:3478", username: "u", credential: "p" }];

describe("checking a relay", () => {
  it("asks for relayed routes only, and finds one when the relay answers", async () => {
    const pc = fakeConnection([{ candidate: relayed }, { candidate: null }]);
    expect(await probeRelay(servers, { connect: pc.connect })).toBe("works");
    expect(pc.configs[0]).toEqual({ iceServers: servers, iceTransportPolicy: "relay" });
    expect(pc.closed()).toBe(true);
  });

  it("tells a refused password from a relay that never answered", async () => {
    const refused = fakeConnection([{ errorCode: 401 }, { candidate: null }]);
    expect(await probeRelay(servers, { connect: refused.connect })).toBe("refused");
    const silent = fakeConnection([{ errorCode: 701 }, { candidate: null }]);
    expect(await probeRelay(servers, { connect: silent.connect })).toBe("unreachable");
  });

  it("gives up when gathering never ends", async () => {
    const pc = fakeConnection([]);
    expect(await probeRelay(servers, { connect: pc.connect, timeoutMs: 20 })).toBe("unreachable");
    expect(pc.closed()).toBe(true);
  });
});
