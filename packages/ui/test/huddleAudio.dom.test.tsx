import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type HuddlePeer } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { webPlatform } from "../src/platform.js";
import { HuddleBar } from "../src/components/HuddleBar.js";
import { HuddleAudio } from "../src/components/HuddleAudio.js";

/** Where call preferences are kept, as in the app. */
const platform = webPlatform();

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

const spyPlay = () => vi.spyOn(HTMLMediaElement.prototype, "play");
let play: ReturnType<typeof spyPlay>;
beforeEach(() => {
  play = spyPlay();
});
afterEach(() => vi.restoreAllMocks());

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
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <HuddleBar />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
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

const peer = (userId: string): HuddlePeer => ({
  userId,
  audioStream: {} as MediaStream,
  cameraStream: null,
  screenStream: null,
  connected: true,
  micMuted: false,
  speaking: false,
});

describe("recovering huddle audio", () => {
  it("offers one gesture to retry blocked peers and leaves audible peers playing", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("Autoplay blocked", "NotAllowedError"))
      .mockRejectedValueOnce(new DOMException("Autoplay blocked", "NotAllowedError"))
      .mockResolvedValue(undefined);
    const peers = [peer("A"), peer("B"), peer("C")];
    const { container } = render(<HuddleAudio peers={peers} />);
    const retry = await screen.findByRole("button", { name: "Turn on sound" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(play).toHaveBeenCalledTimes(3);
    fireEvent.click(retry);
    // These calls happen inside the click, before an effect or another task.
    expect(play).toHaveBeenCalledTimes(5);
    const audio = container.querySelectorAll("audio");
    expect(play.mock.contexts.slice(3)).toEqual([audio[0], audio[1]]);
    await waitFor(() => expect(screen.queryByRole("button")).not.toBeInTheDocument());
    expect(audio[2]!.srcObject).toBe(peers[2]!.audioStream);
  });

  it("keeps recovery available when another playback attempt fails", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValue(new Error("Device unavailable"));
    render(<HuddleAudio peers={[peer("A")]} />);
    const retry = await screen.findByRole("button", { name: "Turn on sound" });
    fireEvent.click(retry);
    await act(async () => {});
    expect(play).toHaveBeenCalledTimes(2);
    expect(retry).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Call audio could not start.");
  });

  it("ignores a removed peer's late rejection and detaches its stream", async () => {
    let reject!: (reason: Error) => void;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    const { container, rerender } = render(<HuddleAudio peers={[peer("A")]} />);
    const audio = container.querySelector("audio")!;
    rerender(<HuddleAudio peers={[]} />);
    await act(async () => reject(new Error("Late failure")));
    expect(audio.srcObject).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not let a superseded stream's failure block a working replacement", async () => {
    let reject!: (reason: Error) => void;
    vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    const { rerender } = render(<HuddleAudio peers={[peer("A")]} />);
    rerender(<HuddleAudio peers={[peer("A")]} />);
    await act(async () => reject(new Error("Old stream failed")));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
