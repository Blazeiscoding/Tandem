import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { Sidebar } from "../src/components/Sidebar.js";
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

/**
 * The sidebar over a workspace client that never connects. The workspace
 * screen passes People and Apps only to administrators.
 */
function sidebar(options: { admin: boolean }) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const self = { ...sam, role: options.admin ? ("admin" as const) : ("member" as const) };
  client.store.setState({
    self,
    users: { U_SAM: self },
    status: "online",
    workspaceName: "Rocket Team",
  });
  const calls: string[] = [];
  const call = (name: string) => () => calls.push(name);
  render(
    <ClientContext.Provider value={client}>
      <Sidebar
        activeChannelId={null}
        onSelect={vi.fn()}
        onBrowseChannels={vi.fn()}
        onNewChannel={vi.fn()}
        onNewDm={vi.fn()}
        onFriends={vi.fn()}
        onSearch={vi.fn()}
        onSaved={vi.fn()}
        onScheduled={vi.fn()}
        onActivity={vi.fn()}
        onThreads={vi.fn()}
        onEditProfile={vi.fn()}
        onInvite={call("invite")}
        onSwitchWorkspace={call("switch")}
        onAccountSettings={call("account")}
        {...(options.admin ? { onManagePeople: call("people"), onManageApps: call("apps") } : {})}
        connectionLabel={null}
      />
    </ClientContext.Provider>,
  );
  return { calls, client, user: userEvent.setup() };
}

async function workspaceMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Workspace" }));
  const menu = screen.getByRole("menu", { name: "Workspace" });
  return {
    menu,
    items: within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  };
}

describe("the workspace menu", () => {
  it("offers administrators People and Apps beside what everyone gets", async () => {
    const { user } = sidebar({ admin: true });
    const footer = document.querySelector("nav footer")!;
    // Words, not the symbols that used to stand in for them.
    expect(footer).not.toHaveTextContent(/[⚙⇄]/);
    const { menu, items } = await workspaceMenu(user);
    expect(items).toEqual([
      "Invite people",
      "People",
      "Apps and integrations",
      "Switch workspace",
      "Account settings",
    ]);
    expect(await accessibilityProblems(menu)).toEqual([]);
  });

  it("offers members only what they can use", async () => {
    const { user } = sidebar({ admin: false });
    const { items } = await workspaceMenu(user);
    expect(items).toEqual(["Invite people", "Switch workspace", "Account settings"]);
  });

  it("does what each item names", async () => {
    const { user, calls } = sidebar({ admin: true });
    for (const item of [
      "Invite people",
      "People",
      "Apps and integrations",
      "Switch workspace",
      "Account settings",
    ]) {
      await workspaceMenu(user);
      await user.click(screen.getByRole("menuitem", { name: item }));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    }
    expect(calls).toEqual(["invite", "people", "apps", "switch", "account"]);
  });
});

describe("pausing notifications", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["late in the evening", new Date(2026, 8, 25, 21, 30)],
    ["early in the morning", new Date(2026, 8, 25, 7, 15)],
  ])("pauses until the next morning, %s, rather than for twelve hours", async (_, now) => {
    // Only the clock is fake, so the pointer and the menu still run on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const { client, user } = sidebar({ admin: false });
    vi.spyOn(client.api, "updateMe").mockImplementation(async (body) => ({
      user: { ...client.state.self!, ...body },
    }));
    const morning = new Date(2026, 8, 26, 9, 0);
    const time = morning.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    await user.click(screen.getByRole("button", { name: "Pause notifications" }));
    await user.click(screen.getByRole("button", { name: `Until tomorrow at ${time}` }));

    expect(client.state.self?.dndUntil).toBe(morning.getTime());
    expect(client.api.updateMe).toHaveBeenCalledWith({ dndUntil: morning.getTime() });
    expect(screen.getByText(`Paused until tomorrow at ${time}`)).toBeInTheDocument();
  });
});
