import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { WorkspaceClient } from "@slackoss/client-core";
import { App } from "../src/App.js";
import type { Platform, SavedServer } from "../src/platform.js";

const rocket: SavedServer = {
  url: "http://127.0.0.1:9",
  token: "test-token-not-a-credential",
  workspaceName: "Rocket Team",
  handle: "sam",
  lastUsedAt: 1,
};

/** A browser with one saved sign-in, and a way to hand the app links as they arrive. */
function appWithLinks() {
  let deliver: (url: string) => void = () => {};
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(key: string) => (key === "servers" ? [rocket] : null) as T | null,
      set: async () => {},
    },
    notify: () => {},
    deepLinks: {
      consumePending: async () => null,
      subscribe: (cb) => {
        deliver = cb;
        return () => {};
      },
    },
  };
  render(<App platform={platform} />);
  return {
    follow: (url: string) =>
      act(async () => {
        deliver(url);
      }),
  };
}

describe("following links from one workspace to another", () => {
  afterEach(() => vi.restoreAllMocks());

  it("leaves nothing of the open workspace connected behind the join screen, and can go back to it", async () => {
    // Workspace clients that never reach a server, and a record of which ones closed.
    const connect = vi.spyOn(WorkspaceClient.prototype, "connect").mockImplementation(() => {});
    const destroy = vi.spyOn(WorkspaceClient.prototype, "destroy");
    const { follow } = appWithLinks();
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    const opened = connect.mock.contexts[0];

    // An invite to a workspace this browser has never signed in to.
    await follow("slackoss://join?host=127.0.0.1:10&code=ABCD1234");
    await waitFor(() => expect(destroy.mock.contexts).toContain(opened));

    // A link back to a message in the first one opens that workspace again,
    // rather than taking it for the one still on screen.
    await follow("slackoss://message?host=127.0.0.1:9&channel=C_DESIGN&id=M_PLAN");
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  });
});
