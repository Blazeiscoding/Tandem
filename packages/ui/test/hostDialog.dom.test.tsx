import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostDialog } from "../src/components/HostDialog.js";
import { useHostingStatus } from "../src/lib/hosting.js";
import type { HostedWorkspaces, HostingStart, HostingStatus, Platform } from "../src/platform.js";
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
function fakeHosting(initial: HostingStatus, hosted?: HostedWorkspaces) {
  let current = initial;
  const listeners = new Set<(status: HostingStatus) => void>();
  const hosting = {
    status: vi.fn(async () => current),
    start: vi.fn(async (request: HostingStart) => {
      const workspaceName =
        "folder" in request
          ? hosted!.workspaces.find((w) => w.folder === request.folder)!.name
          : request.workspaceName;
      current = { ...running, workspaceName };
      return current;
    }),
    ...(hosted
      ? {
          list: vi.fn(async () => hosted),
          forget: vi.fn(async (_folder: string) => {}),
          restore: vi.fn(async (): Promise<{ folder: string; name: string } | null> => ({
            folder: "w-restored",
            name: "Rocket Team",
          })),
          backup: vi.fn(async (folder: string): Promise<{ path: string; at: number } | null> => ({
            path: `/backups/${folder}-2026-09-25T10-00-00`,
            at: Date.now(),
          })),
          rename: vi.fn(async (folder: string, name: string) => ({ folder, name: name.trim() })),
          openFolder: vi.fn(async (_folder: string) => {}),
        }
      : {}),
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
        ? {
            ...current,
            publicAddress: address,
            publicAddressSetting: address,
            inviteOnly: true,
            openToAllError: undefined,
          }
        : {
            ...current,
            publicAddress: undefined,
            publicAddressSetting: undefined,
            inviteOnly: true,
            openToAllError: undefined,
          };
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
  onClose?: () => void;
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
          onClose={props.onClose ?? (() => {})}
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

  it("lists the workspaces hosted here, and starts one by its entry rather than its name", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, {
      workspaces: [
        {
          folder: "w-2",
          name: "Team-A",
          port: 8544,
          lastHostedAt: 2,
          lastBackupAt: null,
          running: false,
          missing: false,
        },
        {
          folder: "team-a",
          name: "Team A",
          port: 8543,
          lastHostedAt: 1,
          lastBackupAt: null,
          running: false,
          missing: false,
        },
        {
          folder: "gone",
          name: "Old Club",
          port: 8545,
          lastHostedAt: 0,
          lastBackupAt: null,
          running: false,
          missing: true,
        },
      ],
      unreadable: ["broken"],
    });
    render(<Harness hosting={hosting} />);

    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Team-APort 8544"),
      expect.stringContaining("Team APort 8543"),
      expect.stringContaining("Old ClubIts folder is missing"),
    ]);
    expect(
      within(list).getByRole("button", { name: "Remove Old Club from the list" }),
    ).toBeEnabled();
    expect(list).toHaveTextContent("Could not read the workspace in the folder broken");
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);

    await user.click(within(list).getByRole("button", { name: "Start hosting Team A" }));
    expect(hosting.start).toHaveBeenCalledWith({ folder: "team-a" });
  });

  it("says a new workspace will be separate from one already hosted under that name", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, {
      workspaces: [
        {
          folder: "team-a",
          name: "Team A",
          port: 8543,
          lastHostedAt: 1,
          lastBackupAt: null,
          running: false,
          missing: false,
        },
      ],
      unreadable: [],
    });
    render(<Harness hosting={hosting} />);

    const name = await screen.findByRole("textbox", { name: "Workspace name" });
    // Nothing is filled in for them: the field only ever makes a new workspace.
    expect(name).toHaveValue("");
    await user.type(name, " team a ");
    expect(screen.getByText(/Team A is already hosted here/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Start new workspace" }));
    expect(hosting.start).toHaveBeenCalledWith({ workspaceName: "team a" });
  });

  it("backs up a listed workspace, says where it went, and when it last was", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, {
      workspaces: [
        {
          folder: "team-a",
          name: "Team A",
          port: 8543,
          lastHostedAt: 1,
          lastBackupAt: null,
          running: false,
          missing: false,
        },
      ],
      unreadable: [],
    });
    render(<Harness hosting={hosting} />);
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    expect(list).toHaveTextContent("Port 8543 · Not backed up yet");

    hosting.list!.mockResolvedValueOnce({
      workspaces: [
        {
          folder: "team-a",
          name: "Team A",
          port: 8543,
          lastHostedAt: 1,
          lastBackupAt: Date.now(),
          running: false,
          missing: false,
        },
      ],
      unreadable: [],
    });
    await user.click(within(list).getByRole("button", { name: "Back up Team A" }));
    expect(hosting.backup).toHaveBeenCalledWith("team-a");
    expect(
      await screen.findByText("Backed up Team A to /backups/team-a-2026-09-25T10-00-00"),
    ).toHaveAttribute("role", "status");
    await waitFor(() => expect(list).toHaveTextContent(/Backed up today, /));
  });

  it("says why a backup did not finish, and nothing when no folder was chosen", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, {
      workspaces: [
        {
          folder: "team-a",
          name: "Team A",
          port: 8543,
          lastHostedAt: 1,
          lastBackupAt: null,
          running: false,
          missing: false,
        },
      ],
      unreadable: [],
    });
    hosting.backup!.mockResolvedValueOnce(null);
    hosting.backup!.mockRejectedValueOnce(new Error("There is not enough free space there."));
    render(<Harness hosting={hosting} />);
    const button = await screen.findByRole("button", { name: "Back up Team A" });
    await user.click(button);
    expect(within(screen.getByRole("dialog")).queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The backup of Team A did not finish. There is not enough free space there.",
    );
  });

  it("backs up the running workspace from where it is managed", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(
      { ...running, folder: "team-a" },
      {
        workspaces: [
          {
            folder: "team-a",
            name: "Rocket Team",
            port: 8543,
            lastHostedAt: 1,
            lastBackupAt: null,
            running: true,
            missing: false,
          },
        ],
        unreadable: [],
      },
    );
    render(<Harness hosting={hosting} />);
    expect(
      await screen.findByText("This workspace has not been backed up from this computer yet."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    expect(hosting.backup).toHaveBeenCalledWith("team-a");
    expect(await screen.findByText(/^Backed up Rocket Team to \/backups\/team-a-/)).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("takes a workspace whose folder is gone out of the list", async () => {
    const user = userEvent.setup();
    const gone = {
      folder: "gone",
      name: "Old Club",
      port: 8545,
      lastHostedAt: 0,
      lastBackupAt: null,
      running: false,
      missing: true,
    };
    const { hosting } = fakeHosting(stopped, { workspaces: [gone], unreadable: [] });
    render(<Harness hosting={hosting} />);
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    expect(within(list).queryByRole("button", { name: "Start hosting Old Club" })).toBeNull();
    expect(within(list).queryByRole("button", { name: "Back up Old Club" })).toBeNull();

    hosting.list!.mockResolvedValueOnce({ workspaces: [], unreadable: [] });
    await user.click(within(list).getByRole("button", { name: "Remove Old Club from the list" }));
    expect(hosting.forget).toHaveBeenCalledWith("gone");
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Hosted on this computer" })).toBeNull(),
    );
  });

  it("restores a backup into the list without starting it, or says why it did not", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, { workspaces: [], unreadable: [] });
    hosting.restore!.mockResolvedValueOnce(null);
    hosting.restore!.mockRejectedValueOnce(
      new Error(
        "Rocket Team is already hosted on this computer, so this backup was not restored over it.",
      ),
    );
    render(<Harness hosting={hosting} />);
    const restore = await screen.findByRole("button", { name: "Restore from a backup…" });

    // No folder chosen: nothing to say.
    await user.click(restore);
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();

    await user.click(restore);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The backup was not restored. Rocket Team is already hosted on this computer",
    );

    const listReads = hosting.list!.mock.calls.length;
    await user.click(restore);
    expect(
      await screen.findByText("Restored Rocket Team. Start it from the list when you are ready."),
    ).toHaveAttribute("role", "status");
    expect(hosting.start).not.toHaveBeenCalled();
    await waitFor(() => expect(hosting.list!.mock.calls.length).toBeGreaterThan(listReads));
  });

  it("says when the list of hosted workspaces cannot be read", async () => {
    const { hosting } = fakeHosting(stopped, { workspaces: [], unreadable: [] });
    hosting.list!.mockRejectedValueOnce(new Error("settings unreadable"));
    render(<Harness hosting={hosting} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Could not read the list of workspaces hosted on this computer/,
    );
  });

  it("explains an unsupported newer hosted-workspace registry without suggesting file repair", async () => {
    const { hosting } = fakeHosting(stopped, { workspaces: [], unreadable: [] });
    hosting.list!.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'hosting:list': Error: The hosted workspace list was saved by a newer version of Gatherline. Update Gatherline to open it; the list was not changed.",
      ),
    );
    render(<Harness hosting={hosting} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/newer version of Gatherline/);
    expect(alert).toHaveTextContent(/Update Gatherline/);
    expect(alert).not.toHaveTextContent(/settings file can be read/);
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

describe("renaming a hosted workspace and opening its folder", () => {
  const teamA = {
    folder: "team-a",
    name: "Team A",
    port: 8543,
    lastHostedAt: 1,
    lastBackupAt: null,
    running: false,
    missing: false,
  };

  it("renames a listed workspace in place, and hands focus back to Rename", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, { workspaces: [teamA], unreadable: [] });
    render(<Harness hosting={hosting} />);
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });

    await user.click(within(list).getByRole("button", { name: "Rename Team A" }));
    const field = within(list).getByRole("textbox", { name: "New name for Team A" });
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Team A");
    const save = within(list).getByRole("button", { name: "Save" });
    // Nothing has changed yet, and a name that is only spaces is none at all.
    expect(save).toBeDisabled();
    await user.clear(field);
    await user.type(field, "   ");
    expect(save).toBeDisabled();
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);

    hosting.list!.mockResolvedValue({
      workspaces: [{ ...teamA, name: "Blue Team" }],
      unreadable: [],
    });
    await user.clear(field);
    await user.type(field, " Blue Team {Enter}");
    expect(hosting.rename).toHaveBeenCalledWith("team-a", " Blue Team ");
    expect(await screen.findByText("Renamed Team A to Blue Team.")).toHaveAttribute(
      "role",
      "status",
    );
    const renamed = await within(list).findByRole("button", { name: "Rename Blue Team" });
    expect(renamed).toHaveFocus();
    // The folder stays what it was: starting it still names the folder.
    await user.click(within(list).getByRole("button", { name: "Start hosting Blue Team" }));
    expect(hosting.start).toHaveBeenCalledWith({ folder: "team-a" });
  });

  it("keeps the form open, saying why, when the name is refused", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, { workspaces: [teamA], unreadable: [] });
    hosting.rename!.mockRejectedValueOnce(
      new Error("The folder for Team A holds a different workspace, so it was not renamed."),
    );
    render(<Harness hosting={hosting} />);
    await user.click(await screen.findByRole("button", { name: "Rename Team A" }));
    const field = screen.getByRole("textbox", { name: "New name for Team A" });
    await user.clear(field);
    await user.type(field, "Blue Team{Enter}");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The folder for Team A holds a different workspace, so it was not renamed.",
    );
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(alert.textContent!);
    expect(field).toHaveFocus();
    // Changing the name clears what was wrong with the last one.
    await user.type(field, "s");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field).toHaveAttribute("aria-invalid", "false");
  });

  it("calls off a rename with Escape, without closing the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { hosting } = fakeHosting(stopped, { workspaces: [teamA], unreadable: [] });
    render(<Harness hosting={hosting} onClose={onClose} />);
    await user.click(await screen.findByRole("button", { name: "Rename Team A" }));
    await user.type(screen.getByRole("textbox", { name: "New name for Team A" }), " changed");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("textbox", { name: /New name for/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Rename Team A" })).toHaveFocus();
    expect(hosting.rename).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // Once the form is gone, Escape closes the dialog as usual.
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renames the running workspace from where it is managed", async () => {
    const user = userEvent.setup();
    const { hosting, push } = fakeHosting(
      { ...running, folder: "team-a" },
      { workspaces: [{ ...teamA, name: "Rocket Team", running: true }], unreadable: [] },
    );
    render(<Harness hosting={hosting} />);
    await user.click(await screen.findByRole("button", { name: "Rename Rocket Team" }));
    const field = screen.getByRole("textbox", { name: "New name for Rocket Team" });
    await user.clear(field);
    await user.type(field, "Blue Team");
    const form = screen.getByRole("form", { name: "Rename Rocket Team" });
    await user.click(within(form).getByRole("button", { name: "Save" }));

    expect(hosting.rename).toHaveBeenCalledWith("team-a", "Blue Team");
    expect(await screen.findByText("Renamed Rocket Team to Blue Team.")).toBeVisible();
    // The main process tells every window of the new name.
    push({ ...running, folder: "team-a", workspaceName: "Blue Team" });
    expect(screen.getByRole("dialog")).toHaveTextContent("Blue Team");
    expect(screen.getByRole("button", { name: "Rename Blue Team" })).toHaveFocus();
  });

  it("opens a workspace's folder, and says when it could not", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, { workspaces: [teamA], unreadable: [] });
    render(<Harness hosting={hosting} />);
    const open = await screen.findByRole("button", { name: "Open folder for Team A" });
    await user.click(open);
    expect(hosting.openFolder).toHaveBeenCalledWith("team-a");
    expect(screen.queryByRole("alert")).toBeNull();

    hosting.openFolder!.mockRejectedValueOnce(new Error("The folder that held Team A is missing."));
    await user.click(open);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The folder that held Team A is missing.",
    );
  });

  it("offers neither where the app cannot do them", async () => {
    const { hosting } = fakeHosting(stopped, { workspaces: [teamA], unreadable: [] });
    delete (hosting as Partial<typeof hosting>).rename;
    delete (hosting as Partial<typeof hosting>).openFolder;
    render(<Harness hosting={hosting} />);
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    expect(within(list).queryByRole("button", { name: /^Rename/ })).toBeNull();
    expect(within(list).queryByRole("button", { name: /^Open folder/ })).toBeNull();
  });
});

describe("starting with the computer", () => {
  const teamA = {
    folder: "team-a",
    name: "Rocket Team",
    port: 8543,
    lastHostedAt: 1,
    lastBackupAt: null,
    running: false,
    missing: false,
  };

  function withLaunch(initial: HostingStatus, atLogin: boolean | null = false) {
    const fake = fakeHosting(initial, {
      workspaces: [{ ...teamA, running: initial.running }],
      unreadable: [],
    });
    const hosting = fake.hosting as typeof fake.hosting & {
      setStartOnLaunch: ReturnType<typeof vi.fn>;
      openAtLogin: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
    };
    let login = atLogin;
    hosting.setStartOnLaunch = vi.fn(async (folder: string | null) => {
      fake.push({ ...initial, startsOnLaunch: folder === "team-a" });
    });
    hosting.openAtLogin = {
      get: vi.fn(async () => login),
      set: vi.fn(async (open: boolean) => (login = open)),
    };
    return { hosting, push: fake.push };
  }

  it("starts the running workspace with Gatherline, and opens Gatherline at sign-in, when asked", async () => {
    const user = userEvent.setup();
    const { hosting } = withLaunch({ ...running, folder: "team-a" });
    render(<Harness hosting={hosting} />);
    const group = await screen.findByRole("group", { name: "When this computer starts" });
    const start = within(group).getByRole("checkbox", {
      name: "Start hosting Rocket Team when Gatherline opens",
    });
    const login = await within(group).findByRole("checkbox", {
      name: "Open Gatherline when you sign in to this computer",
    });
    expect(start).not.toBeChecked();
    expect(login).not.toBeChecked();
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);

    await user.click(start);
    expect(hosting.setStartOnLaunch).toHaveBeenCalledWith("team-a");
    await waitFor(() => expect(start).toBeChecked());
    await user.click(login);
    expect(hosting.openAtLogin.set).toHaveBeenCalledWith(true);
    await waitFor(() => expect(login).toBeChecked());
    expect(group).toHaveTextContent(/With both on, Rocket Team is back for teammates/);

    await user.click(start);
    expect(hosting.setStartOnLaunch).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(start).not.toBeChecked());
  });

  it("offers only what this copy of the app can do", async () => {
    const { hosting } = withLaunch({ ...running, folder: "team-a" }, null);
    render(<Harness hosting={hosting} />);
    const group = await screen.findByRole("group", { name: "When this computer starts" });
    await waitFor(() => expect(hosting.openAtLogin.get).toHaveBeenCalled());
    expect(within(group).queryByRole("checkbox", { name: /sign in/ })).toBeNull();
    expect(group).toHaveTextContent("Rocket Team starts once Gatherline is opened.");
  });

  it("says why a choice could not be saved", async () => {
    const user = userEvent.setup();
    const { hosting } = withLaunch({ ...running, folder: "team-a" });
    hosting.setStartOnLaunch.mockRejectedValueOnce(
      new Error(
        "Gatherline could not save that choice. Check that its settings folder is writable, then try again.",
      ),
    );
    render(<Harness hosting={hosting} />);
    const start = await screen.findByRole("checkbox", {
      name: "Start hosting Rocket Team when Gatherline opens",
    });
    await user.click(start);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gatherline could not save that choice. Check that its settings folder is writable, then try again.",
    );
    // Nothing was saved, so the box goes back to what is so.
    expect(start).not.toBeChecked();
  });

  it("says why the chosen workspace did not start, and marks it in the list", async () => {
    const fake = fakeHosting(
      {
        ...stopped,
        launchError:
          "Gatherline did not start hosting Rocket Team when it opened. Its folder is missing.",
      },
      { workspaces: [{ ...teamA, startsOnLaunch: true }], unreadable: [] },
    );
    render(<Harness hosting={fake.hosting} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gatherline did not start hosting Rocket Team when it opened. Its folder is missing.",
    );
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    expect(list).toHaveTextContent("Port 8543 · Starts with Gatherline");
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

  it("explains that a blank override keeps the configured Cloudflare address", async () => {
    const { hosting } = fakeHosting({
      ...running,
      tunnelAvailable: true,
      publicAddress: configured,
      publicAddressManaged: true,
    });
    render(<Harness hosting={hosting} />);

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(
      within(dialog).getByText(/empty to use the configured Cloudflare address/),
    ).toBeVisible();
    expect(
      within(dialog).queryByText(/empty to create a temporary address/),
    ).not.toBeInTheDocument();
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
    expect(within(dialog).getByText(/stays the same when you reopen it/)).toBeVisible();
    expect(within(dialog).queryByText(/This temporary address/)).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(/only you can stop its external tunnel or proxy/),
    ).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Stop using address" })).toBeEnabled();
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
    const address = within(dialog).getByLabelText("Your own address");
    expect(address).toHaveValue("http://localhost:8543");
    expect(address).toHaveAttribute("aria-invalid", "true");
    expect(address).toHaveAttribute("aria-errormessage", "public-address-error");
    expect(address).toHaveAccessibleDescription(/public HTTPS hostname/);
  });

  it("warns that an external carrier can already expose the workspace", async () => {
    const { hosting } = fakeHosting({
      ...running,
      tunnelAvailable: true,
      publicAddress: funnel,
      publicAddressSetting: funnel,
      inviteOnly: true,
    });
    render(<Harness hosting={hosting} />);

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByText(/may already make this workspace reachable/)).toBeVisible();
    expect(within(dialog).getByText(/stop the carrier separately/)).toBeVisible();
    expect(within(dialog).getByRole("checkbox", { name: /Require an invite/ })).toBeChecked();
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
