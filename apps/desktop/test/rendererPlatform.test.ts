import { afterEach, describe, expect, it } from "vitest";
import { electronPlatform } from "../src/renderer/src/platform.js";

type Bridge = Window["slackoss"];

/**
 * The renderer reads its bridge off `window` when the platform is built, so a
 * stub is enough to drive it; nothing else in the module touches the DOM.
 */
function platformRejecting(reason: unknown) {
  const failing = () => Promise.reject(reason);
  (globalThis as { window?: unknown }).window = {
    slackoss: {
      hostingOpenToAll: failing,
      hostingSetPublicAddress: failing,
    } as unknown as Bridge,
  };
  return electronPlatform();
}

/** The whole message, since a leftover prefix would still contain the sentence. */
async function messageFrom(call: Promise<unknown>): Promise<string> {
  return call.then(
    () => "resolved",
    (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
  );
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("what the renderer shows when the main process refuses", () => {
  it("shows the sentence the main process wrote, not the channel it arrived on", async () => {
    const platform = platformRejecting(
      new Error(
        "Error invoking remote method 'hosting:setPublicAddress': Error: Use a public HTTPS hostname without a path, credentials, query, or fragment.",
      ),
    );

    expect(await messageFrom(platform.hosting!.setPublicAddress!("http://localhost:8543"))).toBe(
      "Use a public HTTPS hostname without a path, credentials, query, or fragment.",
    );
  });

  it("does the same for opening to all, whatever the handler's error class was named", async () => {
    const platform = platformRejecting(
      new Error(
        "Error invoking remote method 'hosting:openToAll': TypeError: Stop using the current public address before changing it.",
      ),
    );

    expect(await messageFrom(platform.hosting!.openToAll!({ inviteOnly: true }))).toBe(
      "Stop using the current public address before changing it.",
    );
  });

  it("leaves a message that never went through Electron alone", async () => {
    const platform = platformRejecting(new Error("The app is quitting."));

    expect(await messageFrom(platform.hosting!.setPublicAddress!(""))).toBe("The app is quitting.");
  });

  it("keeps something to read when the prefix is the whole message", async () => {
    const bare = "Error invoking remote method 'hosting:setPublicAddress': Error: ";
    const platform = platformRejecting(new Error(bare));

    expect(await messageFrom(platform.hosting!.setPublicAddress!(""))).toBe(bare);
  });

  it("names the workspace to rename or open by its folder, and repeats why it would not", async () => {
    const renames: [string, string][] = [];
    (globalThis as { window?: unknown }).window = {
      slackoss: {
        hostingRename: async (folder: string, name: string) => {
          renames.push([folder, name]);
          if (!name.trim())
            throw new Error(
              "Error invoking remote method 'hosting:rename': Error: Use a workspace name of 1 to 80 characters without control characters.",
            );
          return { folder, name: name.trim() };
        },
        hostingOpenFolder: async () => {
          throw new Error(
            "Error invoking remote method 'hosting:openFolder': Error: The folder for Rocket Team could not be opened.",
          );
        },
      } as unknown as Bridge,
    };
    const hosting = electronPlatform().hosting!;

    expect(await hosting.rename!("rocket-team", " Blue Team ")).toEqual({
      folder: "rocket-team",
      name: "Blue Team",
    });
    expect(await messageFrom(hosting.rename!("rocket-team", " "))).toBe(
      "Use a workspace name of 1 to 80 characters without control characters.",
    );
    expect(renames).toEqual([
      ["rocket-team", " Blue Team "],
      ["rocket-team", " "],
    ]);
    expect(await messageFrom(hosting.openFolder!("rocket-team"))).toBe(
      "The folder for Rocket Team could not be opened.",
    );
  });

  it("reports a rejection that was never an Error at all", async () => {
    const platform = platformRejecting("the connector went away");

    expect(await messageFrom(platform.hosting!.setPublicAddress!(""))).toBe(
      "the connector went away",
    );
  });
});
