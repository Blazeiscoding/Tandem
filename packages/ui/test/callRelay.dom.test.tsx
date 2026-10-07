import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CallRelayDraft, CallRelaySetting } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

const probe = vi.hoisted(() => ({ result: "works" as "works" | "refused" | "unreachable" }));
vi.mock("../src/lib/relayProbe.js", () => ({
  probeRelay: vi.fn(async () => probe.result),
}));

const { CallRelaySettings } = await import("../src/components/CallRelaySettings.js");
const { probeRelay } = await import("../src/lib/relayProbe.js");

/** The desktop app's relay bridge, keeping what it was last given. */
function fakeRelay(initial: CallRelaySetting) {
  let saved = initial;
  return {
    get: vi.fn(async () => saved),
    set: vi.fn(async (draft: CallRelayDraft) => {
      saved =
        draft.kind === "cloudflare"
          ? { kind: "cloudflare", keyId: draft.keyId }
          : draft.kind === "custom"
            ? { kind: "custom", urls: draft.urls, username: draft.username }
            : { kind: "none" };
      return saved;
    }),
    test: vi.fn(async (_draft: CallRelayDraft) => [
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "p" },
    ]),
  };
}

describe("the call relay in Manage hosting", () => {
  it("saves a Cloudflare key and its token, and says calls from now on can use it", async () => {
    const relay = fakeRelay({ kind: "none" });
    render(<CallRelaySettings relay={relay} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Cloudflare" }));
    await user.type(screen.getByLabelText("TURN key ID"), "4c1b5e7f9a");
    await user.type(screen.getByLabelText("API token"), "secret-token");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(relay.set).toHaveBeenCalledWith({
      kind: "cloudflare",
      keyId: "4c1b5e7f9a",
      apiToken: "secret-token",
    });
    expect(await screen.findByText("Saved. Calls that start from now on can use it.")).toBeTruthy();
    expect(screen.getByText("Relay on")).toBeTruthy();
    // The token is never shown again; the field says one is kept.
    expect((screen.getByLabelText("API token") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("API token").getAttribute("placeholder")).toMatch(/Saved/);
    expect(await accessibilityProblems()).toEqual([]);
  });

  it("leaves a saved password out of what it sends, so the one kept is used", async () => {
    const relay = fakeRelay({
      kind: "custom",
      urls: ["turn:relay.example.org:3478"],
      username: "workspace",
    });
    render(<CallRelaySettings relay={relay} />);
    const user = userEvent.setup();
    const addresses = await screen.findByLabelText("Addresses, one per line");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    await user.type(addresses, "\nturns:relay.example.org:5349");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(relay.set).toHaveBeenCalledWith({
      kind: "custom",
      urls: ["turn:relay.example.org:3478", "turns:relay.example.org:5349"],
      username: "workspace",
    });
  });

  it("checks the relay gives a route, and says what went wrong when it does not", async () => {
    const relay = fakeRelay({ kind: "cloudflare", keyId: "4c1b5e7f9a" });
    render(<CallRelaySettings relay={relay} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Test" }));
    expect(relay.test).toHaveBeenCalledWith({ kind: "cloudflare", keyId: "4c1b5e7f9a" });
    expect(probeRelay).toHaveBeenCalledWith([
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "p" },
    ]);
    expect(
      await screen.findByText("The relay works: this computer reached it and got a route."),
    ).toBeTruthy();

    probe.result = "refused";
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("The relay refused the username or password.")).toBeTruthy();

    relay.test.mockRejectedValueOnce(
      new Error("Cloudflare refused the API token for this TURN key."),
    );
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(
      await screen.findByText("Cloudflare refused the API token for this TURN key."),
    ).toBeTruthy();
  });

  it("shows why the relay is not working when calls found out", async () => {
    const relay = fakeRelay({
      kind: "cloudflare",
      keyId: "4c1b5e7f9a",
      error: "Cloudflare refused the API token for this TURN key.",
    });
    render(<CallRelaySettings relay={relay} />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Cloudflare refused the API token for this TURN key.",
    );
  });

  it("turns the relay off", async () => {
    const relay = fakeRelay({ kind: "cloudflare", keyId: "4c1b5e7f9a" });
    render(<CallRelaySettings relay={relay} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "No relay" }));
    expect(screen.queryByRole("button", { name: "Test" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(relay.set).toHaveBeenCalledWith({ kind: "none" });
    await waitFor(() => expect(screen.queryByText("Relay on")).toBeNull());
  });
});
