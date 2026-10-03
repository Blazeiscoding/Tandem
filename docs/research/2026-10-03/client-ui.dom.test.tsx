import { writeFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createServer } from "node:http";
import { transferableAbortController } from "node:util";
import WebSocket from "ws";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Api, WorkspaceClient } from "@slackoss/client-core";
import { createWorkspaceServer } from "@slackoss/server";
import type { ModalView, User } from "@slackoss/protocol";
import type { Platform } from "../../../packages/ui/src/platform.js";
import { ClientContext, PlatformContext } from "../../../packages/ui/src/context.js";
import { ViewModal } from "../../../packages/ui/src/components/ViewModal.js";
import { HuddleButton } from "../../../packages/ui/src/components/HuddleBar.js";

const evidence: Record<string, unknown> = {
  revision: "cd3af584ba46adace45465cb5e5c66afb238b01c",
  scope:
    "Production React components in jsdom. Three focused synthetic controls plus one actual HTTP/socket/two-app callback journey; no real browser geometry or media.",
};
const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() =>
  writeFileSync(
    new NodeURL("./client-ui-evidence.json", import.meta.url),
    JSON.stringify(evidence, null, 2) + "\n",
  ),
);
const sam: User = {
  id: "U_SYNTHETIC",
  handle: "synthetic",
  displayName: "Synthetic",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
function client() {
  const result = new WorkspaceClient("http://127.0.0.1:9", "synthetic-only");
  result.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  clients.push(result);
  return result;
}
function modal(id: string, initialValue = ""): ModalView {
  return {
    id,
    callbackId: id,
    title: `Form ${id}`,
    submitLabel: "Submit",
    closeLabel: "Cancel",
    privateMetadata: "",
    text: "",
    fields: [
      {
        blockId: "details",
        actionId: "value",
        label: "Details",
        hint: "",
        optional: false,
        type: "text",
        placeholder: "",
        initialValue,
        options: [],
      },
    ],
  };
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("new UI boundaries", () => {
  it("diagnostic: a replacing modal inherits and submits the previous form's words", async () => {
    const c = client();
    c.store.setState({ modal: modal("V_A") });
    const submit = vi.spyOn(c.api, "submitView").mockResolvedValue({ ok: false, errors: {} });
    render(
      <ClientContext.Provider value={c}>
        <ViewModal />
      </ClientContext.Provider>,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", { name: "Details" }),
      "Synthetic private words intended for app A",
    );
    act(() => c.store.setState({ modal: modal("V_B", "B's initial value") }));
    expect(screen.getByRole("dialog", { name: "Form V_B" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Details" })).toHaveValue(
      "Synthetic private words intended for app A",
    );
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submit).toHaveBeenCalledWith("V_B", {
      details: { value: "Synthetic private words intended for app A" },
    });
    evidence.replacedModalValues = {
      newView: "V_B",
      visibleValue: (screen.getByRole("textbox", { name: "Details" }) as HTMLInputElement).value,
      submittedViewId: submit.mock.calls[0]![0],
      submittedValues: submit.mock.calls[0]![1],
    };
  });
  it("diagnostic: an old refusal appears on the replacement form", async () => {
    const c = client();
    c.store.setState({ modal: modal("V_A") });
    const answer = deferred<{ ok: boolean; errors?: Record<string, string> }>();
    vi.spyOn(c.api, "submitView").mockReturnValueOnce(answer.promise);
    render(
      <ClientContext.Provider value={c}>
        <ViewModal />
      </ClientContext.Provider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => c.store.setState({ modal: modal("V_B") }));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    await act(async () =>
      answer.resolve({ ok: false, errors: { details: "Synthetic rejection for app A" } }),
    );
    expect(await screen.findByText("Synthetic rejection for app A")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Form V_B" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Details" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    evidence.staleModalRefusal = {
      currentView: c.state.modal?.id,
      displayedErrorFrom: "V_A",
      busyInheritedBeforeOldAnswer: true,
    };
  });
  it("diagnostic: huddle is clickable while a saved join-muted preference is loading", async () => {
    const c = client();
    const stored = deferred<unknown>();
    const platform: Platform = {
      kind: "web",
      storage: { get: <T,>() => stored.promise as Promise<T | null>, set: async () => {} },
      notify: () => {},
    };
    const join = vi.spyOn(c, "joinHuddle").mockResolvedValue();
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={c}>
          <HuddleButton channelId="C_SYNTHETIC" />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const button = screen.getByRole("button", { name: "Start a huddle" });
    expect(button).toBeEnabled();
    await userEvent.setup().click(button);
    expect(join).toHaveBeenNthCalledWith(1, "C_SYNTHETIC", { muted: false });
    await act(async () => stored.resolve({ joinMuted: true }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Start a huddle" }));
    await waitFor(() => expect(join).toHaveBeenNthCalledWith(2, "C_SYNTHETIC", { muted: true }));
    evidence.pendingJoinMutedRead = {
      clickableBeforeRead: true,
      firstJoin: join.mock.calls[0]![1],
      savedPreference: { joinMuted: true },
      nextJoin: join.mock.calls[1]![1],
    };
  });
  it("real HTTP/socket diagnostic: replacing app B receives the words typed into app A", async () => {
    // The production client/API use Node HTTP in this DOM runtime. Node event
    // and Abort constructors avoid jsdom cross-realm incompatibility, without
    // mocking actual socket, trigger authorization or interactivity delivery.
    vi.stubGlobal("WebSocket", WebSocket);
    const abort = transferableAbortController();
    vi.stubGlobal("AbortController", abort.constructor);
    vi.stubGlobal("AbortSignal", abort.signal.constructor);
    const received: { path: string; body: string }[] = [];
    const hook = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        received.push({ path: request.url ?? "", body });
        const challenge = body.startsWith("{")
          ? (JSON.parse(body) as { challenge?: string }).challenge
          : undefined;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(challenge ? JSON.stringify({ challenge }) : "");
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
    const hookPort = (hook.address() as { port: number }).port;
    const workspace = await createWorkspaceServer({
      dataDir: ":memory:",
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      rateLimits: false,
      allowPrivateHooks: true,
    });
    const base = `http://127.0.0.1:${workspace.port}`;
    let c: WorkspaceClient | null = null;
    try {
      const account = await new Api(base).register({
        handle: "research",
        displayName: "Synthetic Research",
        password: "syntheticPassword123",
      });
      const api = new Api(base, account.token);
      c = new WorkspaceClient(base, account.token);
      c.connect();
      await expect.poll(() => c!.state.status).toBe("online");
      const channelId = Object.values(c.state.channels).find(
        (channel) => channel.name === "general",
      )!.id;
      const appA = await api.createApp({ name: "Synthetic app A" });
      const appB = await api.createApp({ name: "Synthetic app B" });
      await api.setInteractivityUrl(appA.app.id, `http://127.0.0.1:${hookPort}/app-A`);
      await api.setInteractivityUrl(appB.app.id, `http://127.0.0.1:${hookPort}/app-B`);
      async function post(path: string, token: string, body: unknown) {
        const response = await fetch(base + path, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.ok).toBe(true);
        return (await response.json()) as Record<string, unknown>;
      }
      async function open(app: typeof appA, title: string, hookPath: string) {
        const posted = await post("/api/chat.postMessage", app.token, {
          channel: channelId,
          text: "Synthetic form button",
          blocks: [
            {
              type: "actions",
              elements: [
                { type: "button", action_id: "open", text: { type: "plain_text", text: "Open" } },
              ],
            },
          ],
        });
        await api.runMessageAction(posted.ts as string, "open");
        const action = [...received]
          .reverse()
          .find((entry) => entry.path === hookPath && entry.body.startsWith("payload="))!;
        const payload = JSON.parse(new URLSearchParams(action.body).get("payload")!) as {
          trigger_id: string;
        };
        const opened = await post("/api/views.open", app.token, {
          trigger_id: payload.trigger_id,
          view: {
            type: "modal",
            callback_id: title,
            title: { type: "plain_text", text: title },
            submit: { type: "plain_text", text: "Submit" },
            blocks: [
              {
                type: "input",
                block_id: "details",
                label: { type: "plain_text", text: "Details" },
                element: { type: "plain_text_input", action_id: "value" },
              },
            ],
          },
        });
        expect(opened.ok).toBe(true);
        await expect.poll(() => c!.state.modal?.title).toBe(title);
        return (opened.view as { id: string }).id;
      }
      const viewA = await open(appA, "Real synthetic app A", "/app-A");
      const component = render(
        <ClientContext.Provider value={c}>
          <ViewModal />
        </ClientContext.Provider>,
      );
      const user = userEvent.setup();
      await user.type(
        screen.getByRole("textbox", { name: "Details" }),
        "Synthetic private words for A only",
      );
      let viewB = "";
      await act(async () => {
        viewB = await open(appB, "Real synthetic app B", "/app-B");
      });
      expect(screen.getByRole("textbox", { name: "Details" })).toHaveValue(
        "Synthetic private words for A only",
      );
      await user.click(screen.getByRole("button", { name: "Submit" }));
      await expect
        .poll(() =>
          received.some(
            (entry) => entry.path === "/app-B" && entry.body.includes("view_submission"),
          ),
        )
        .toBe(true);
      const delivery = received.find(
        (entry) => entry.path === "/app-B" && entry.body.includes("view_submission"),
      )!;
      const payload = JSON.parse(new URLSearchParams(delivery.body).get("payload")!) as {
        view: {
          id: string;
          callback_id: string;
          state: { values: { details: { value: { value: string } } } };
        };
      };
      expect(payload.view.id).toBe(viewB);
      expect(payload.view.state.values.details.value.value).toBe(
        "Synthetic private words for A only",
      );
      evidence.realCrossAppModal = {
        transport:
          "Actual HTTP, production trigger checks, socket pushes, production ViewModal and real webhook callback",
        differentApps: appA.app.id !== appB.app.id,
        viewA,
        viewB,
        submittedView: payload.view.id,
        deliveredTo: delivery.path,
        deliveredCallback: payload.view.callback_id,
        deliveredWords: payload.view.state.values.details.value.value,
        prerequisite:
          "Same user invokes app B's valid action while A is open, e.g. through another window/device; then explicitly submits B.",
      };
      component.unmount();
    } finally {
      c?.destroy();
      await workspace.stop();
      await new Promise<void>((resolve) => hook.close(() => resolve()));
    }
  });
});
