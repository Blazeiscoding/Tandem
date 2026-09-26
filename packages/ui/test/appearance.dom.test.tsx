import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { AccountDialog } from "../src/components/AccountDialog.js";
import { useApplyAppearance } from "../src/lib/appearance.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
});

function Applied() {
  useApplyAppearance();
  return null;
}

/** Appearance settings on a device whose storage holds `saved`, and may refuse to save. */
function appearance(saved: unknown, options: { failSave?: boolean } = {}) {
  const set = vi.fn(async (_name: string, _value: unknown) => {
    if (options.failSave) throw new Error("storage is full");
  });
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(name: string) => (name === "appearance" ? saved : null) as T | null,
      set,
    },
    notify: () => {},
  };
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  vi.spyOn(client.api, "listSessions").mockResolvedValue({ sessions: [] });
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <Applied />
        <AccountDialog onClose={() => {}} onSignedOut={() => {}} section="appearance" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const panel = screen.getByRole("tabpanel", { name: "Appearance" });
  return { panel, set, user: userEvent.setup() };
}

const root = () => document.documentElement.dataset;

describe("how Gatherline looks on this device", () => {
  it("applies what was saved, and offers every theme and density", async () => {
    const { panel } = appearance({ theme: "contrast", density: "compact" });
    await waitFor(() => expect(root().theme).toBe("contrast"));
    expect(root().density).toBe("compact");
    const themes = within(panel).getByRole("group", { name: "Theme" });
    expect(
      within(themes)
        .getAllByRole("radio")
        .map((r) => r.closest("label")!.firstChild?.nextSibling?.firstChild?.textContent),
    ).toEqual(["Match this device", "Dark", "Light", "High contrast"]);
    expect(within(themes).getByRole("radio", { name: /High contrast/ })).toBeChecked();
    expect(within(panel).getByRole("radio", { name: /Compact/ })).toBeChecked();
    expect(await accessibilityProblems(panel)).toEqual([]);
  });

  it("stays dark and comfortable when nothing, or nothing it knows, was saved", async () => {
    appearance({ theme: "sepia", density: 3 });
    await waitFor(() => expect(root().theme).toBe("dark"));
    expect(root().density).toBe("comfortable");
  });

  it("changes at once when chosen, and keeps the choice", async () => {
    const { panel, set, user } = appearance(null);
    await waitFor(() => expect(within(panel).getByRole("radio", { name: /^Dark/ })).toBeEnabled());
    await user.click(within(panel).getByRole("radio", { name: /^Light/ }));
    expect(root().theme).toBe("light");
    expect(set).toHaveBeenLastCalledWith("appearance", { theme: "light", density: "comfortable" });
    await user.click(within(panel).getByRole("radio", { name: /^Compact/ }));
    expect(root().density).toBe("compact");
    expect(set).toHaveBeenLastCalledWith("appearance", { theme: "light", density: "compact" });
  });

  it("goes back and says so when the choice cannot be kept", async () => {
    const { panel, user } = appearance(
      { theme: "dark", density: "comfortable" },
      { failSave: true },
    );
    await waitFor(() => expect(within(panel).getByRole("radio", { name: /^Dark/ })).toBeEnabled());
    await user.click(within(panel).getByRole("radio", { name: /^Light/ }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "Could not save how Gatherline looks on this device.",
    );
    expect(root().theme).toBe("dark");
    expect(within(panel).getByRole("radio", { name: /^Dark/ })).toBeChecked();
  });
});
