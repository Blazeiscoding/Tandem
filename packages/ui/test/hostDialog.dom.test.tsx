import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostDialog, useHostingStatus } from "../src/components/HostDialog.js";
import type { HostingStatus, Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

type Hosting = NonNullable<Platform["hosting"]>;

const stopped: HostingStatus = { running: false, phase: "stopped" };
const publicUrl = "https://rocket-team.trycloudflare.com";
const running: HostingStatus = {
  running: true,
  phase: "running",
  workspaceName: "Rocket Team",
  port: 8543,
  lanUrls: ["192.168.1.20:8543"],
  dataDir: "C:\\Users\\sam\\AppData\\Roaming\\Gatherline\\hosted\\rocket-team",
  backgroundAvailable: true,
};

/** The desktop app's hosting bridge, with a status that can change underneath the dialog. */
function fakeHosting(initial: HostingStatus) {
  let current = initial;
  const listeners = new Set<(status: HostingStatus) => void>();
  const hosting = {
    status: vi.fn(async () => current),
    start: vi.fn(async ({ workspaceName }: { workspaceName: string; port?: number }) => {
      current = { ...running, workspaceName };
      return current;
    }),
    stop: vi.fn(async () => {
      current = stopped;
    }),
    openToAll: vi.fn(async ({ inviteOnly }: { inviteOnly: boolean }) => {
      current = {
        ...current,
        openToAll: { phase: "open", url: publicUrl },
        tunnelAvailable: true,
        inviteOnly,
      };
      return current;
    }),
    endOpenToAll: vi.fn(async () => {
      delete current.openToAll;
      current = { ...current, openToAllError: undefined };
      return current;
    }),
    setInviteOnly: vi.fn(async (inviteOnly: boolean) => {
      current = { ...current, inviteOnly };
      return current;
    }),
    // The main process validates and saves; here it simply takes what it is given.
    setPublicAddress: vi.fn(async (address: string) => {
      current = address
        ? { ...current, publicAddress: address, publicAddressSetting: address }
        : { ...current, publicAddress: undefined, publicAddressSetting: undefined };
      return current;
    }),
    subscribe: (listener: (status: HostingStatus) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  /** A change made somewhere else, such as the tray, arriving while the dialog is open. */
  const push = (next: HostingStatus) => {
    current = next;
    act(() => listeners.forEach((listener) => listener(next)));
  };
  return { hosting, push };
}

/** Holds the status the way the app does, above a dialog that may not be open yet. */
function Harness(props: {
  hosting: Hosting;
  open?: boolean;
  viewingHosted?: boolean;
  onStarted?: (status: HostingStatus) => void;
}) {
  const state = useHostingStatus(props.hosting);
  return (
    <>
      <output>{state.status ? "status known" : "status unknown"}</output>
      {props.open !== false && (
        <HostDialog
          hosting={props.hosting}
          state={state}
          viewingHosted={props.viewingHosted}
          onClose={() => {}}
          onStarted={props.onStarted ?? (() => {})}
        />
      )}
    </>
  );
}

describe("hosting a workspace from the host dialog", () => {
  it("asks for a name, and starts hosting under it", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped);
    const onStarted = vi.fn();
    render(<Harness hosting={hosting} onStarted={onStarted} />);

    const name = await screen.findByRole("textbox", { name: "Workspace name" });
    const start = screen.getByRole("button", { name: "Start hosting" });
    expect(start).toBeDisabled();
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);
    await user.type(name, "  Rocket Team ");
    await user.click(start);

    expect(hosting.start).toHaveBeenCalledWith({ workspaceName: "Rocket Team" });
    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith(
        expect.objectContaining({ running: true, port: 8543 }),
      ),
    );
  });

  it("keeps the name, and says what went wrong, when hosting cannot start", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped);
    hosting.start.mockRejectedValueOnce(new Error("listen EADDRINUSE"));
    const onStarted = vi.fn();
    render(<Harness hosting={hosting} onStarted={onStarted} />);

    const name = await screen.findByRole("textbox", { name: "Workspace name" });
    await user.type(name, "Rocket Team");
    await user.click(screen.getByRole("button", { name: "Start hosting" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not start/);
    expect(name).toHaveValue("Rocket Team");
    expect(screen.getByRole("button", { name: "Start hosting" })).toBeEnabled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("says where teammates connect, and what closing the window does, while hosting", async () => {
    const { hosting } = fakeHosting(running);
    render(<Harness hosting={hosting} />);

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByText("Rocket Team")).toBeVisible();
    expect(within(dialog).getByText("192.168.1.20:8543")).toBeVisible();
    expect(within(dialog).getByText("8543")).toBeVisible();
    expect(within(dialog).getByText(running.dataDir!)).toBeVisible();
    expect(
      within(dialog).getByText(/keeps the workspace running in the system tray/),
    ).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("opens, copies, secures, and closes a public Cloudflare address", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({ ...running, tunnelAvailable: true });
    render(<Harness hosting={hosting} />);

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    const inviteRequired = within(dialog).getByRole("checkbox", {
      name: /Require an invite link to create an account/,
    });
    expect(inviteRequired).toBeChecked();

    await user.click(within(dialog).getByRole("button", { name: "Open to all" }));
    expect(hosting.openToAll).toHaveBeenCalledWith({ inviteOnly: true });
    expect(await within(dialog).findByRole("link", { name: publicUrl })).toHaveAttribute(
      "href",
      publicUrl,
    );
    expect(within(dialog).getByText("Public")).toBeVisible();
    expect(within(dialog).getByText(/Workspace → Invite people/)).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "Copy address" }));
    expect(await navigator.clipboard.readText()).toBe(publicUrl);
    expect(within(dialog).getByRole("button", { name: "Copied" })).toBeVisible();

    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /Require an invite link to create an account/,
      }),
    );
    expect(hosting.setInviteOnly).toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(
        within(dialog).getByRole("checkbox", {
          name: /Require an invite link to create an account/,
        }),
      ).not.toBeChecked(),
    );
    expect(
      within(dialog).getByText(/Anyone with this address can create an account/),
    ).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Close public link" }));
    expect(hosting.endOpenToAll).toHaveBeenCalledOnce();
    expect(await within(dialog).findByRole("button", { name: "Open to all" })).toBeEnabled();
    expect(within(dialog).queryByRole("link", { name: publicUrl })).not.toBeInTheDocument();
  });

  it("explains when cloudflared is unavailable and can check again", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({ ...running, tunnelAvailable: false });
    render(<Harness hosting={hosting} />);

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByText(/Install Cloudflare’s cloudflared tool/)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Open to all" })).not.toBeInTheDocument();
    const callsBeforeCheck = hosting.status.mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(hosting.status).toHaveBeenCalledTimes(callsBeforeCheck + 1));
  });

  it("keeps hosting and reports an error when opening the public address fails", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({ ...running, tunnelAvailable: true });
    hosting.openToAll.mockRejectedValueOnce(new Error("cloudflared could not reach the edge"));
    render(<Harness hosting={hosting} />);

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    await user.click(within(dialog).getByRole("button", { name: "Open to all" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /public link could not be opened/,
    );
    expect(within(dialog).getByText("Rocket Team")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Open to all" })).toBeEnabled();
    expect(hosting.stop).not.toHaveBeenCalled();
  });

  it("offers to open the hosted workspace only when it is not the one already on screen", async () => {
    const { hosting } = fakeHosting(running);
    const { rerender } = render(<Harness hosting={hosting} />);
    expect(await screen.findByRole("button", { name: "Open it" })).toBeEnabled();

    rerender(<Harness hosting={hosting} viewingHosted />);
    expect(screen.queryByRole("button", { name: "Open it" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop hosting" })).toBeInTheDocument();
  });

  it("asks before stopping, and stopping can be called off", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(running);
    render(<Harness hosting={hosting} />);

    await user.click(await screen.findByRole("button", { name: "Stop hosting" }));
    const confirm = screen.getByRole("dialog", { name: "Stop hosting?" });
    expect(confirm).toHaveTextContent(/Teammates will be disconnected/);
    // The trigger was replaced by the confirmation. Focus must stay inside
    // rather than falling back to the page behind the modal.
    await waitFor(() => expect(confirm).toContainElement(document.activeElement as HTMLElement));
    await user.tab();
    expect(confirm).toContainElement(document.activeElement as HTMLElement);
    await user.click(within(confirm).getByRole("button", { name: "Keep hosting" }));
    expect(screen.getByRole("dialog", { name: "Workspace is live" })).toBeInTheDocument();
    expect(hosting.stop).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Stop hosting" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Stop hosting?" })).getByRole("button", {
        name: "Stop hosting",
      }),
    );
    expect(hosting.stop).toHaveBeenCalledOnce();
    expect(await screen.findByRole("dialog", { name: "Host a workspace" })).toBeInTheDocument();
  });

  it("keeps showing what it knows while it checks the status again", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped);
    const { rerender } = render(<Harness hosting={hosting} open={false} />);
    await screen.findByText("status known");
    expect(hosting.status).toHaveBeenCalledTimes(1);

    // Opening the dialog checks again, and this time the answer is slow.
    let finishRefresh!: (status: HostingStatus) => void;
    hosting.status.mockReturnValueOnce(
      new Promise<HostingStatus>((resolve) => {
        finishRefresh = resolve;
      }),
    );
    rerender(<Harness hosting={hosting} />);
    expect(hosting.status).toHaveBeenCalledTimes(2);
    const name = screen.getByRole("textbox", { name: "Workspace name" });
    await user.type(name, "Rocket");
    expect(screen.queryByText("Checking hosting status…")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toBe(name);
    expect(name).toHaveValue("Rocket");

    await act(async () => finishRefresh(stopped));
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toBe(name);
    expect(name).toHaveValue("Rocket");
  });

  it("follows a change made elsewhere while it is open", async () => {
    const { hosting, push } = fakeHosting(stopped);
    render(<Harness hosting={hosting} />);
    await screen.findByRole("dialog", { name: "Host a workspace" });

    push(running);
    const dialog = screen.getByRole("dialog", { name: "Workspace is live" });
    push({ ...running, phase: "stopping" });
    expect(within(dialog).getByText("Stopping workspace…")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Stop hosting" })).toBeDisabled();
  });
});

describe("a stable public address configured for the desktop app", () => {
  const configured = "https://chat.example.org";

  it("offers the configured address, and where to route it, instead of a temporary one", async () => {
    const { hosting } = fakeHosting({
      ...running,
      tunnelAvailable: true,
      publicAddress: configured,
    });
    render(<Harness hosting={hosting} />);

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByText(configured)).toBeVisible();
    expect(within(dialog).getByText("http://127.0.0.1:8543")).toBeVisible();
    expect(within(dialog).queryByText(/Create a temporary HTTPS address/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Open to all" })).toBeEnabled();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("says the open address will be the same one next time", async () => {
    const open: HostingStatus = {
      ...running,
      tunnelAvailable: true,
      publicAddress: configured,
      openToAll: { phase: "open", url: configured },
    };
    const { hosting } = fakeHosting(open);
    render(<Harness hosting={hosting} />);

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(await within(dialog).findByRole("link", { name: configured })).toHaveAttribute(
      "href",
      configured,
    );
    expect(
      within(dialog).getByText(/stays the same when you reopen the public link/),
    ).toBeVisible();
    expect(within(dialog).queryByText(/This temporary address/)).not.toBeInTheDocument();
  });

  it("says what to correct, and opens nothing, while the configuration is unusable", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({
      ...running,
      tunnelAvailable: true,
      publicAddressError: "Set both GATHERLINE_TUNNEL_URL and GATHERLINE_TUNNEL_TOKEN_FILE.",
    });
    render(<Harness hosting={hosting} />);

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/Set both GATHERLINE_TUNNEL_URL/);
    const open = within(dialog).getByRole("button", { name: "Open to all" });
    expect(open).toBeDisabled();

    await user.click(open);
    expect(hosting.openToAll).not.toHaveBeenCalled();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });
});

describe("an address the host already has", () => {
  const funnel = "https://box.tail1234.ts.net";

  it("takes one, trims it, and publishes it as the workspace's own", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({ ...running, tunnelAvailable: true });
    render(<Harness hosting={hosting} />);

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Your own address"), `  ${funnel}  `);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(hosting.setPublicAddress).toHaveBeenCalledWith(funnel);
    expect(await within(dialog).findByText(funnel)).toBeVisible();
    // Nothing here is Cloudflare's, so it must not tell them to route it there.
    expect(within(dialog).getByText(/Send this address to/)).toBeVisible();
    expect(within(dialog).queryByText(/In Cloudflare, route/)).not.toBeInTheDocument();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("repeats what the app says about an address it will not take", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({ ...running, tunnelAvailable: true });
    hosting.setPublicAddress.mockRejectedValueOnce(
      new Error("Use a public HTTPS hostname without a path, credentials, query, or fragment."),
    );
    render(<Harness hosting={hosting} />);

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    await user.type(within(dialog).getByLabelText("Your own address"), "http://localhost:8543");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/public HTTPS hostname/);
    expect(within(dialog).getByLabelText("Your own address")).toHaveValue("http://localhost:8543");
  });

  it("shows an address the environment fixed without offering to change it", async () => {
    const { hosting } = fakeHosting({
      ...running,
      tunnelAvailable: true,
      publicAddress: funnel,
      publicAddressSetting: funnel,
      publicAddressLocked: true,
    });
    render(<Harness hosting={hosting} />);

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByLabelText("Your own address")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).getByText(/comes from an environment variable/)).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });
});
