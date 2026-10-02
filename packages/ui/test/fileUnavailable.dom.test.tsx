import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WorkspaceClient } from "@slackoss/client-core";
import type { FileMeta } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { Lightbox } from "../src/components/Attachments.js";

/** An open image whose message is deleted, or whose conversation is lost, says so (F07). */
const file: FileMeta = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  name: "plan.png",
  mime: "image/png",
  size: 4,
} as FileMeta;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("an open image that is taken away (F07)", () => {
  it("stops showing it and says it is unavailable", async () => {
    const urls = new Set<string>();
    // jsdom has neither; the browser's are what the cache uses.
    const { createObjectURL, revokeObjectURL } = URL;
    onTestFinished(() => {
      Object.assign(URL, { createObjectURL, revokeObjectURL });
    });
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:test/${urls.size}`;
      urls.add(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => void urls.delete(url));
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    vi.spyOn(client.api, "fetchFile").mockResolvedValue(new Blob(["png!"]));
    render(
      <ClientContext.Provider value={client}>
        <Lightbox file={file} onClose={() => {}} />
      </ClientContext.Provider>,
    );
    expect(await screen.findByRole("img", { name: "plan.png" })).toBeTruthy();

    act(() => client.files.invalidate(file.id));
    expect(screen.queryByRole("img", { name: "plan.png" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(
      /unavailable or you no longer have access/i,
    );
    expect(urls.size).toBe(0);
  });
});
