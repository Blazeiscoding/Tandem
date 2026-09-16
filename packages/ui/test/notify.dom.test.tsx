import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationBanner } from "../src/components/NotificationBanner.js";
import { webPlatform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/** A browser Notification stand-in the tests can answer through. */
function installNotification(permission: NotificationPermission) {
  const created: Array<{
    title: string;
    body?: string;
    onclick: ((event: Event) => void) | null;
    close: () => void;
    closed: boolean;
  }> = [];
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = requestPermission;
    onclick: ((event: Event) => void) | null = null;
    closed = false;
    title: string;
    body?: string;
    constructor(title: string, options?: { body?: string }) {
      this.title = title;
      this.body = options?.body;
      created.push(this as unknown as (typeof created)[number]);
    }
    close() {
      this.closed = true;
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  return { created, requestPermission };
}

afterEach(() => vi.unstubAllGlobals());

describe("the notification banner", () => {
  it("offers to turn notifications on, and goes away once they are", async () => {
    const { requestPermission } = installNotification("default");
    const user = userEvent.setup();
    render(<NotificationBanner />);
    const banner = screen.getByRole("region", { name: "Notifications" });
    expect(banner).toHaveTextContent(/mentions while Gatherline is in the background/);
    expect(await accessibilityProblems(banner)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Turn on" }));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
  });

  it("waits for the next sign-in when dismissed instead of asking again", async () => {
    installNotification("default");
    const user = userEvent.setup();
    render(<NotificationBanner />);
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
  });

  it("stays out of the way when there is nothing to ask", () => {
    for (const permission of ["granted", "denied"] as const) {
      installNotification(permission);
      const { unmount } = render(<NotificationBanner />);
      expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
      unmount();
    }
    vi.stubGlobal("Notification", undefined);
    render(<NotificationBanner />);
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
  });
});

describe("a notification", () => {
  it("opens its message when clicked, and asks nothing when permission is missing", async () => {
    const { created } = installNotification("granted");
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    try {
      const opened: string[] = [];
      webPlatform().notify("Sam in #design", "ping", () => opened.push("message"));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ title: "Sam in #design", body: "ping" });

      created[0]!.onclick?.(new Event("click"));
      expect(opened).toEqual(["message"]);
      expect(focus).toHaveBeenCalled();
      expect(created[0]!.closed).toBe(true);
    } finally {
      focus.mockRestore();
    }
  });

  it("shows nothing at all when permission was never granted", () => {
    const { created } = installNotification("default");
    webPlatform().notify("Sam in #design", "ping", () => {});
    expect(created).toHaveLength(0);
  });
});
