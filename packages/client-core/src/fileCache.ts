import type { ID } from "@slackoss/protocol";
import type { Api } from "./api.js";

/**
 * Uploads are auth-gated, so an `<img src>` can't fetch them directly.
 * This fetches once with the session token and hands back a blob: URL,
 * deduping concurrent requests for the same file.
 */
export class FileCache {
  private urls = new Map<ID, string>();
  private inflight = new Map<ID, Promise<string>>();
  private controllers = new Map<ID, AbortController>();
  private sizes = new Map<ID, number>();
  private references = new Map<ID, number>();
  private disposed = false;

  constructor(
    private api: Api,
    private maxIdleBytes = 32 * 1024 * 1024,
  ) {}

  retain(fileId: ID): void {
    this.references.set(fileId, (this.references.get(fileId) ?? 0) + 1);
  }

  release(fileId: ID): void {
    const count = (this.references.get(fileId) ?? 0) - 1;
    if (count > 0) this.references.set(fileId, count);
    else this.references.delete(fileId);
    this.trim();
  }

  private trim(except?: ID): void {
    let idleBytes = 0;
    for (const [id, size] of this.sizes) if (!this.references.has(id)) idleBytes += size;
    for (const [id, url] of this.urls) {
      if (idleBytes <= this.maxIdleBytes) break;
      if (id === except || this.references.has(id)) continue;
      idleBytes -= this.sizes.get(id) ?? 0;
      URL.revokeObjectURL(url);
      this.urls.delete(id);
      this.sizes.delete(id);
    }
  }

  /** A blob URL for the file, cached for the life of the connection. */
  get(fileId: ID): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("File cache is closed"));
    const cached = this.urls.get(fileId);
    if (cached) {
      this.urls.delete(fileId);
      this.urls.set(fileId, cached);
      return Promise.resolve(cached);
    }

    const pending = this.inflight.get(fileId);
    if (pending) return pending;

    const controller = new AbortController();
    this.controllers.set(fileId, controller);
    const request = this.api
      .fetchFile(fileId, controller.signal)
      .then((blob) => {
        if (this.disposed) throw new Error("File cache is closed");
        if (this.inflight.get(fileId) !== request) throw new Error("File access was invalidated");
        const url = URL.createObjectURL(blob);
        this.urls.set(fileId, url);
        this.sizes.set(fileId, blob.size);
        this.trim(fileId);
        this.inflight.delete(fileId);
        if (this.controllers.get(fileId) === controller) this.controllers.delete(fileId);
        return url;
      })
      .catch((err: unknown) => {
        if (this.inflight.get(fileId) === request) this.inflight.delete(fileId);
        if (this.controllers.get(fileId) === controller) this.controllers.delete(fileId);
        throw err;
      });
    this.inflight.set(fileId, request);
    return request;
  }

  /** Already-resolved URL, for a first paint with no flash. */
  peek(fileId: ID): string | undefined {
    return this.urls.get(fileId);
  }

  invalidate(fileId: ID): void {
    this.controllers.get(fileId)?.abort();
    this.controllers.delete(fileId);
    this.inflight.delete(fileId);
    const url = this.urls.get(fileId);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(fileId);
    this.sizes.delete(fileId);
    this.references.delete(fileId);
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.inflight.clear();
    this.sizes.clear();
    this.references.clear();
  }
}
