import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, ServerInfo, User } from "@slackoss/protocol";
import { ClientContext, OpenMessageContext } from "../src/context.js";
import { InviteDialog } from "../src/components/dialogs.js";
import { Mrkdwn } from "../src/components/Mrkdwn.js";
import { ShareableServerProvider } from "../src/components/ShareableServer.js";
import { webPlatform, type HostingStatus, type Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";
import { copyBySelection, withoutClipboardApi } from "./clipboard.js";

const owner: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "owner",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
  canInvite: true,
};

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
  memberIds: ["U_SAM"],
};

/** This computer hosting the workspace, answering on a virtual adapter as well as the office network. */
const hostingHere: HostingStatus = {
  running: true,
  phase: "running",
  workspaceName: "Rocket Team",
  port: 8543,
  lanUrls: ["172.28.64.1:8543", "192.168.1.20:8543"],
};

/**
 * The invite dialog over a workspace client that never connects, below the
 * provider the workspace screen puts it under, with a code already made.
 */
async function inviteWith(options: {
  baseUrl: string;
  publicUrl?: string;
  hosting?: HostingStatus;
}) {
  const client = new WorkspaceClient(options.baseUrl, "test-token-not-a-credential");
  client.store.setState({ self: owner, users: { U_SAM: owner }, status: "online" });
  const info: ServerInfo = {
    app: "slackoss",
    protocolVersion: 1,
    serverVersion: "0.0.0-test",
    workspaceName: "Rocket Team",
    userCount: 3,
    requiresInvite: true,
    requiresClaim: false,
    ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
  };
  vi.spyOn(client.api, "serverInfo").mockResolvedValue(info);
  vi.spyOn(client.api, "listInvites").mockResolvedValue({ invites: [] });
  vi.spyOn(client.api, "createInvite").mockResolvedValue({
    invite: {
      code: "ABCD1234",
      createdBy: "U_SAM",
      createdAt: 0,
      expiresAt: null,
      maxUses: null,
      uses: 0,
      status: "active",
    },
  });
  const hosting = options.hosting;
  const platform: Platform = {
    ...webPlatform(),
    kind: "desktop",
    ...(hosting ? { hosting: { status: async () => hosting, start: vi.fn(), stop: vi.fn() } } : {}),
  };
  const user = userEvent.setup();
  render(
    <ClientContext.Provider value={client}>
      <ShareableServerProvider platform={platform}>
        <InviteDialog onClose={() => {}} />
      </ShareableServerProvider>
    </ClientContext.Provider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Invite people" });
  await user.click(within(dialog).getByRole("button", { name: "Generate invite code" }));
  await within(dialog).findByText("ABCD1234");
  return { dialog: within(dialog), root: dialog, user };
}

describe("inviting someone", () => {
  it("builds links on a network address when this computer hosts the workspace it shows", async () => {
    const { dialog, root, user } = await inviteWith({
      baseUrl: "http://localhost:8543",
      hosting: hostingHere,
    });
    const address = await dialog.findByRole("combobox", { name: "Address used in links" });
    expect(address).toHaveDisplayValue("192.168.1.20:8543");
    expect(dialog.getByText("http://192.168.1.20:8543/#/join/ABCD1234")).toBeVisible();
    expect(dialog.getByText("slackoss://join?host=192.168.1.20:8543&code=ABCD1234")).toBeVisible();
    expect(dialog.queryByText(/reaches only this computer/)).toBeNull();

    // The other address is there for whoever is on that network.
    await user.selectOptions(address, "172.28.64.1:8543");
    expect(dialog.getByText("http://172.28.64.1:8543/#/join/ABCD1234")).toBeVisible();

    await user.click(dialog.getByRole("button", { name: "Copy link" }));
    expect(await navigator.clipboard.readText()).toBe("http://172.28.64.1:8543/#/join/ABCD1234");
    expect(await accessibilityProblems(root)).toEqual([]);
  });

  it("uses the address the host published, whatever this app is connected through", async () => {
    const { dialog } = await inviteWith({
      baseUrl: "http://localhost:8543",
      publicUrl: "https://chat.team.dev",
    });
    expect(await dialog.findByText("https://chat.team.dev/#/join/ABCD1234")).toBeVisible();
    expect(
      dialog.getByText("slackoss://join?host=https://chat.team.dev&code=ABCD1234"),
    ).toBeVisible();
  });

  it("keeps a workspace on https on https, in the desktop app's link too", async () => {
    const { dialog } = await inviteWith({ baseUrl: "https://rocket.example.dev" });
    expect(dialog.getByText("https://rocket.example.dev/#/join/ABCD1234")).toBeVisible();
    expect(
      dialog.getByText("slackoss://join?host=https://rocket.example.dev&code=ABCD1234"),
    ).toBeVisible();
    expect(dialog.queryByText(/reaches only this computer/)).toBeNull();
  });

  it("copies from inside the dialog on a page given no Clipboard API", async () => {
    // A browser that reached the workspace over plain http on the network.
    const { dialog, root, user } = await inviteWith({ baseUrl: "http://192.168.1.20:8543" });
    const restoreApi = withoutClipboardApi();
    const selection = copyBySelection();
    try {
      const copyLink = dialog.getByRole("button", { name: "Copy link" });
      await user.click(copyLink);
      // The dialog keeps focus to itself, so this copy only works from inside it.
      expect(selection.copied).toEqual(["http://192.168.1.20:8543/#/join/ABCD1234"]);
      expect(copyLink).toHaveTextContent("Copied");
      expect(copyLink).toHaveFocus();
      expect(root.querySelector("textarea")).toBeNull();

      await user.click(dialog.getByRole("button", { name: "Copy address" }));
      expect(selection.copied.at(-1)).toBe("192.168.1.20:8543");
    } finally {
      selection.restore();
      restoreApi();
    }
  });

  it("tells someone who cannot create invite codes what joining takes", async () => {
    const member: User = {
      ...owner,
      id: "U_ALEX",
      handle: "alex",
      role: "member",
      canInvite: false,
    };
    const client = new WorkspaceClient("http://192.168.1.20:8543", "test-token-not-a-credential");
    client.store.setState({ self: member, users: { U_ALEX: member }, status: "online" });
    vi.spyOn(client.api, "listInvites").mockResolvedValue({ invites: [] });
    render(
      <ClientContext.Provider value={client}>
        <InviteDialog onClose={() => {}} />
      </ClientContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Invite people" });
    expect(dialog).toHaveTextContent(
      "Anyone joining needs this workspace's address, and an invite code as well if the workspace is invite-only.",
    );
    expect(dialog).not.toHaveTextContent(/Send someone an invite link/);
    expect(within(dialog).getByText("192.168.1.20:8543")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Copy address" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Generate invite code" })).toBeNull();
    await waitFor(() => expect(client.api.listInvites).toHaveBeenCalled());
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("says so when the only address it has works on this computer alone", async () => {
    const { dialog } = await inviteWith({ baseUrl: "http://127.0.0.1:8543" });
    expect(dialog.getByText(/reaches only this computer/)).toBeVisible();
    expect(dialog.getByText("http://127.0.0.1:8543/#/join/ABCD1234")).toBeVisible();
  });
});

describe("a link to a message, written in a message", () => {
  function renderText(text: string) {
    const openMessage = vi.fn();
    render(
      <OpenMessageContext.Provider value={openMessage}>
        <Mrkdwn text={text} users={{ U_SAM: owner }} channels={{ C_DESIGN: design }} />
      </OpenMessageContext.Provider>,
    );
    return openMessage;
  }

  it("opens the message here when it is in this workspace, whatever address the link carries", () => {
    // One person copied it on the office network, another through the public
    // address; both lead to the same message.
    const openMessage = renderText(
      "The plan http://192.168.1.20:8543/#/c/C_DESIGN/m/M_PLAN and from outside https://rocket.example.dev/#/c/C_DESIGN/m/M_PLAN",
    );
    const [onNetwork, outside] = screen.getAllByRole("link");
    // fireEvent reports false when the click's default was prevented.
    expect(fireEvent.click(onNetwork!)).toBe(false);
    expect(fireEvent.click(outside!)).toBe(false);
    expect(openMessage.mock.calls).toEqual([
      ["C_DESIGN", "M_PLAN"],
      ["C_DESIGN", "M_PLAN"],
    ]);
  });

  it("leaves a click asking for a new tab, and any other link, to the browser", () => {
    const openMessage = renderText(
      "http://192.168.1.20:8543/#/c/C_DESIGN/m/M_PLAN http://192.168.1.20:8543/#/c/C_ELSEWHERE/m/M_2 https://example.com/docs",
    );
    // Stops jsdom trying to open the windows a browser would.
    const noWindows = (event: Event) => event.preventDefault();
    document.addEventListener("click", noWindows);
    try {
      const [here, notHere, otherSite] = screen.getAllByRole("link");
      for (const modifier of ["ctrlKey", "metaKey", "shiftKey"]) {
        fireEvent.click(here!, { [modifier]: true });
      }
      fireEvent.click(here!, { button: 1 });
      fireEvent.click(notHere!);
      fireEvent.click(otherSite!);
      expect(openMessage).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("click", noWindows);
    }
  });
});

describe("a browser opened at a link", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("hands the app the link once, and takes it out of the address", async () => {
    window.history.replaceState(null, "", "/#/join/ABCD1234");
    const links = webPlatform().deepLinks!;
    expect(await links.consumePending()).toBe(`${location.origin}/#/join/ABCD1234`);
    // A reload must not act on it again, and the code should not sit in history.
    expect(location.href).toBe(`${location.origin}/`);
    expect(await links.consumePending()).toBeNull();
  });

  it("hands over a link pasted into the address of a page already open", async () => {
    const received = vi.fn();
    const unsubscribe = webPlatform().deepLinks!.subscribe(received);
    try {
      location.hash = "#/c/C_DESIGN/m/M_PLAN";
      await waitFor(() =>
        expect(received).toHaveBeenCalledWith(`${location.origin}/#/c/C_DESIGN/m/M_PLAN`),
      );
      expect(location.hash).toBe("");

      // A fragment that is not a link is left for whatever put it there.
      location.hash = "#notes";
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toHaveBeenCalledTimes(1);
      expect(location.hash).toBe("#notes");
    } finally {
      unsubscribe();
    }
  });
});
