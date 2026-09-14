import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostDialog, useHostingStatus } from "../src/components/HostDialog.js";
import type { HostingStatus, Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

type Hosting = NonNullable<Platform["hosting"]>;

const stopped: HostingStatus = { running: false, phase: "stopped" };
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
