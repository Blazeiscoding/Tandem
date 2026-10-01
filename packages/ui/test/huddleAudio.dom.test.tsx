import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type HuddlePeer } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { HuddleBar } from "../src/components/HuddleBar.js";

/**
 * Hearing the others in a huddle when the browser will not play sound until
 * someone asks (CALL-01). That used to be swallowed, leaving a huddle where
 * nobody could be heard and nothing said why; now the bar says so and asks.
 */
const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.toLowerCase(),
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

const priya: HuddlePeer = {
  userId: "U_PRIYA",
  audioStream: {} as MediaStream,
  cameraStream: null,
  screenStream: null,
  connected: true,
  micMuted: false,
  speaking: false,
};

const play = vi.spyOn(HTMLMediaElement.prototype, "play");
afterEach(() => play.mockReset());

function bar() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const sam = person("U_SAM", "Sam");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam, U_PRIYA: person("U_PRIYA", "Priya") },
    status: "online",
    huddle: {
      channelId: "C_GENERAL",
      micMuted: false,
      cameraOn: false,
      sharingScreen: false,
      localCameraStream: null,
      localScreenStream: null,
      speaking: false,
      micLost: false,
      peers: [priya],
    },
  });
  render(
    <ClientContext.Provider value={client}>
      <HuddleBar />
    </ClientContext.Provider>,
  );
  return client;
}

const refused = () => Promise.reject(new DOMException("play() needs a gesture", "NotAllowedError"));

describe("sound the browser holds back", () => {
  it("says so, and plays once Turn on sound is pressed", async () => {
    const user = userEvent.setup();
    play.mockImplementationOnce(refused).mockResolvedValue();
    bar();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your browser is holding back the huddle's sound.",
    );
    await user.click(screen.getByRole("button", { name: "Turn on sound" }));
    expect(play.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("plays on any key press too, for when the bar is out of sight", async () => {
    const user = userEvent.setup();
    play.mockImplementationOnce(refused).mockResolvedValue();
    bar();
    await screen.findByRole("alert");
    await user.keyboard("{Shift}");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps asking while the browser still refuses", async () => {
    const user = userEvent.setup();
    play.mockImplementation(refused);
    bar();
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Turn on sound" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("says nothing when the sound plays", async () => {
    play.mockResolvedValueOnce();
    bar();
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says nothing of a play cut short by the next stream", async () => {
    play.mockRejectedValueOnce(new DOMException("interrupted by a new load", "AbortError"));
    bar();
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops asking once the person held back leaves", async () => {
    play.mockImplementation(refused);
    const client = bar();
    await screen.findByRole("alert");
    act(() => client.store.setState({ huddle: { ...client.state.huddle!, peers: [] } }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
