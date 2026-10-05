import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { Sidebar, type OtherWorkspace } from "../src/components/Sidebar.js";
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
function sidebar(options: { admin: boolean; others?: OtherWorkspace[] }) {
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
        otherWorkspaces={options.others}
        onOpenWorkspace={(url) => calls.push(`open ${url}`)}
        onAccountSettings={call("account")}
        {...(options.admin ? { onManagePeople: call("people"), onManageApps: call("apps") } : {})}
        connectionLabel={null}
      />
    </ClientContext.Provider>,
  );
  return { calls, client, user: userEvent.setup() };
}

/** The menu on the workspace's name: bringing people in, running it, and moving elsewhere. */
async function workspaceMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Rocket Team, workspace menu" }));
  const menu = screen.getByRole("menu", { name: "Workspace" });
  return {
    menu,
    items: within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  };
}

/** The menu on your own name: your profile, settings, queued messages and help. */
async function accountMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /, your account$/ }));
  const menu = screen.getByRole("menu", { name: "Your account" });
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
      "Add or join a workspace…",
    ]);
    expect(await accessibilityProblems(menu)).toEqual([]);
  });

  it("offers members only what they can use", async () => {
    const { user } = sidebar({ admin: false });
    const { items } = await workspaceMenu(user);
    expect(items).toEqual(["Invite people", "Add or join a workspace…"]);
  });

  it("does what each item names", async () => {
    const { user, calls } = sidebar({ admin: true });
    for (const item of ["Invite people", "People", "Apps and integrations"]) {
      await workspaceMenu(user);
      await user.click(screen.getByRole("menuitem", { name: item }));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    }
    await accountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Account settings" }));
    expect(calls).toEqual(["invite", "people", "apps", "account"]);
  });
});

describe("the account menu", () => {
  it("keeps what concerns only you apart from the workspace's", async () => {
    const { user } = sidebar({ admin: true });
    const { menu, items } = await accountMenu(user);
    expect(items).toEqual(["Profile and status", "Account settings", "Scheduled messages"]);
    expect(await accessibilityProblems(menu)).toEqual([]);
  });

  it("offers the shortcut sheet, diagnostics and scheduled messages when the screen can open them", async () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({ self: sam, users: { U_SAM: sam }, status: "online" });
    const opened: string[] = [];
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
          onScheduled={() => opened.push("scheduled")}
          onActivity={vi.fn()}
          onThreads={vi.fn()}
          onEditProfile={vi.fn()}
          onInvite={vi.fn()}
          onSwitchWorkspace={vi.fn()}
          onAccountSettings={vi.fn()}
          onShortcuts={() => opened.push("shortcuts")}
          onDiagnostics={() => opened.push("diagnostics")}
          connectionLabel={null}
        />
      </ClientContext.Provider>,
    );
    const user = userEvent.setup();
    const { items } = await accountMenu(user);
    expect(items).toEqual([
      "Profile and status",
      "Account settings",
      "Scheduled messages",
      "Keyboard shortcuts",
      "Diagnostics",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Scheduled messages" }));
    await accountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Keyboard shortcuts" }));
    await accountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Diagnostics" }));
    expect(opened).toEqual(["scheduled", "shortcuts", "diagnostics"]);
  });
});

describe("the workspace switcher", () => {
  const others: OtherWorkspace[] = [
    { url: "https://design.example", name: "Design Guild", handle: "sam" },
    { url: "http://10.0.0.5:8543", name: "Rocket Team", handle: "sam.r" },
  ];

  it("is the workspace's name, and lists the others on this device, most recent first", async () => {
    const { user } = sidebar({ admin: false, others });
    const trigger = screen.getByRole("button", { name: "Rocket Team, workspace menu" });
    expect(screen.getByRole("heading", { level: 1 })).toContainElement(trigger);
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "Workspace" });
    // A second workspace with this one's name says which account and address it is.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Invite people",
      "Design Guild · @sam",
      "Rocket Team · @sam.r · 10.0.0.5:8543",
      "Add or join a workspace…",
    ]);
    expect(await accessibilityProblems(menu)).toEqual([]);
  });

  it("opens the one chosen, or the way to add another", async () => {
    const { user, calls } = sidebar({ admin: false, others });
    const trigger = screen.getByRole("button", { name: "Rocket Team, workspace menu" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Design Guild · @sam" }));
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Add or join a workspace…" }));
    expect(calls).toEqual(["open https://design.example", "switch"]);
  });

  it("still offers a way to add one when this is the only workspace", async () => {
    const { user } = sidebar({ admin: false });
    expect(screen.queryByRole("group", { name: "Workspaces" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Rocket Team, workspace menu" }));
    expect(
      within(screen.getByRole("menu", { name: "Workspace" }))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toContain("Add or join a workspace…");
  });

  it("shows the rail of workspaces only once there is another to go to", () => {
    sidebar({ admin: false, others });
    expect(screen.getByRole("group", { name: "Workspaces" })).toBeInTheDocument();
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
    await user.click(screen.getByRole("menuitem", { name: `Until tomorrow at ${time}` }));

    expect(client.state.self?.dndUntil).toBe(morning.getTime());
    expect(client.api.updateMe).toHaveBeenCalledWith({ dndUntil: morning.getTime() });
    expect(screen.getByText(`Paused until tomorrow at ${time}`)).toBeInTheDocument();
  });
});
