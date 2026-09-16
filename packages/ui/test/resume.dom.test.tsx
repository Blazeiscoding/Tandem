import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api } from "@slackoss/client-core";
import type { ServerInfo } from "@slackoss/protocol";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import { hostedButStopped, resumeTarget } from "../src/lib/resume.js";
import type { HostingStatus, Platform, SavedServer } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

const saved: SavedServer = {
  url: "http://localhost:8543",
  token: "test-token-not-a-credential",
  workspaceName: "Rocket Team",
  handle: "sam",
  lastUsedAt: 1,
};

const info: ServerInfo = {
  app: "slackoss",
  protocolVersion: 1,
  serverVersion: "0.0.0-test",
  workspaceName: "Rocket Team",
  userCount: 3,
  requiresInvite: false,
  requiresClaim: false,
};

const stopped: HostingStatus = { running: false, phase: "stopped" };
const running: HostingStatus = {
  running: true,
  phase: "running",
  workspaceName: "Rocket Team",
  port: 8543,
};
const remembered = { workspaceName: "Rocket Team", port: 8543 };

describe("finding the workspace to resume", () => {
  it("matches a saved sign-in by loopback address and port, not by name", () => {
    const target = resumeTarget([saved], stopped, remembered);
    expect(target).toEqual({ saved, workspaceName: "Rocket Team" });
    expect(
      resumeTarget([{ ...saved, url: "http://127.0.0.1:8543" }], stopped, remembered)?.saved.url,
    ).toBe("http://127.0.0.1:8543");
  });

  it("says no when hosting runs, nothing is remembered, or nobody saved it", () => {
    expect(resumeTarget([saved], running, remembered)).toBeNull();
    expect(resumeTarget([saved], { running: false, phase: "starting" }, remembered)).toBeNull();
    expect(resumeTarget([saved], stopped, null)).toBeNull();
    expect(resumeTarget([saved], null, remembered)).toBeNull();
    expect(resumeTarget([], stopped, remembered)).toBeNull();
    expect(
      resumeTarget([{ ...saved, url: "https://chat.example.dev" }], stopped, remembered),
    ).toBeNull();
    expect(
      resumeTarget([{ ...saved, url: "http://localhost:9000" }], stopped, remembered),
    ).toBeNull();
    expect(resumeTarget([{ ...saved, url: "not a url" }], stopped, remembered)).toBeNull();
  });

  it("never mistakes an unreadable bridge for a stopped workspace", async () => {
    await expect(hostedButStopped(saved, undefined)).resolves.toBe(false);
    await expect(
      hostedButStopped(saved, {
        status: async () => stopped,
        lastHosted: async () => {
          throw new Error("settings locked");
        },
      }),
    ).resolves.toBe(false);
    await expect(
      hostedButStopped(saved, {
        status: async () => stopped,
        lastHosted: async () => remembered,
      }),
    ).resolves.toBe(true);
  });
});

/** The join screen over a desktop platform whose hosting answers from stubs. */
function joinWith(options: {
  hostingStatus?: HostingStatus | null;
  lastHosted?: { workspaceName: string; port: number } | null;
  start?: (opts: { workspaceName: string; port?: number }) => Promise<HostingStatus>;
}) {
  const start =
    options.start ??
    (async () => ({ running: true, phase: "running", workspaceName: "Rocket Team", port: 8543 }));
  const startSpy = vi.fn(start);
  const platform: Platform = {
    kind: "desktop",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
    hosting: {
      status: async () => options.hostingStatus ?? stopped,
      start: startSpy,
      stop: async () => {},
      lastHosted: async () => options.lastHosted ?? null,
    },
  };
  render(
    <JoinScreen
      platform={platform}
      savedServers={[saved]}
      onConnected={() => {}}
      onForget={() => {}}
      onHostClick={() => {}}
      hostingStatus={options.hostingStatus ?? stopped}
      lastHosted={options.lastHosted ?? null}
    />,
  );
  return { start: startSpy, user: userEvent.setup() };
}

afterEach(() => vi.restoreAllMocks());

describe("resuming a hosted workspace", () => {
  it("offers to host it again instead of reconnecting to nothing", async () => {
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    const { start, user } = joinWith({ lastHosted: remembered });
    const card = screen.getByRole("region", { name: "Hosted on this computer" });
    expect(card).toHaveTextContent(/Rocket Team.*isn’t running/);
    expect(await accessibilityProblems(card)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Start hosting Rocket Team" }));
    expect(start).toHaveBeenCalledWith({ workspaceName: "Rocket Team", port: 8543 });
    // Started on its remembered port, the saved sign-in opens again.
    expect(await screen.findByRole("heading", { name: "Rocket Team" })).toBeVisible();
  });

  it("says when starting fails instead of leaving a spinner", async () => {
    const { user } = joinWith({
      lastHosted: remembered,
      start: async () => {
        throw new Error("port taken");
      },
    });
    await user.click(screen.getByRole("button", { name: "Start hosting Rocket Team" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/port may be in use/);
  });

  it("stays quiet when hosting runs, nothing is remembered, or nobody saved it", async () => {
    for (const options of [
      { hostingStatus: running, lastHosted: remembered },
      { lastHosted: null },
    ] as const) {
      const { unmount } = render(
        <JoinScreen
          platform={{
            kind: "desktop",
            storage: { get: async () => null, set: async () => {} },
            notify: () => {},
          }}
          savedServers={[saved]}
          onConnected={() => {}}
          onForget={() => {}}
          hostingStatus={options.hostingStatus ?? stopped}
          lastHosted={options.lastHosted ?? null}
        />,
      );
      expect(screen.queryByRole("region", { name: "Hosted on this computer" })).toBeNull();
      unmount();
    }
  });
});
