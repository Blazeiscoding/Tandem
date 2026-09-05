import { describe, expect, it, vi } from "vitest";
import { FileCache } from "../src/fileCache.js";
import type { Api } from "../src/api.js";

describe("attachment cache", () => {
  it("evicts old idle blobs while retaining visible attachments", async () => {
    const fetchFile = vi.fn(async () => new Blob(["1234"]));
    const cache = new FileCache({ fetchFile } as unknown as Api, 4);
    cache.retain("visible");
    const visible = await cache.get("visible");
    await cache.get("old");
    await cache.get("new");
    expect(cache.peek("visible")).toBe(visible);
    expect(cache.peek("old")).toBeUndefined();
    expect(cache.peek("new")).toBeTruthy();
    cache.release("visible");
    expect(cache.peek("visible")).toBeUndefined();
    cache.dispose();
  });

  it("deduplicates downloads and does not resurrect blobs after disconnect", async () => {
    let finish!: (blob: Blob) => void;
    const fetchFile = vi.fn(() => new Promise<Blob>((r) => { finish = r; }));
    const cache = new FileCache({ fetchFile } as unknown as Api);
    const first = cache.get("image");
    const second = cache.get("image");
    expect(first).toBe(second);
    expect(fetchFile).toHaveBeenCalledOnce();
    cache.dispose();
    finish(new Blob(["late"]));
    await expect(first).rejects.toThrow("closed");
    expect(cache.peek("image")).toBeUndefined();
  });
});
