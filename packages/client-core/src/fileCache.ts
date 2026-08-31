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

  constructor(private api: Api) {}

  /** A blob URL for the file, cached for the life of the connection. */
  get(fileId: ID): Promise<string> {
    const cached = this.urls.get(fileId);
    if (cached) return Promise.resolve(cached);

    const pending = this.inflight.get(fileId);
    if (pending) return pending;

    const request = this.api
      .fetchFile(fileId)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        this.urls.set(fileId, url);
        this.inflight.delete(fileId);
        return url;
      })
      .catch((err: unknown) => {
        this.inflight.delete(fileId);
        throw err;
      });
    this.inflight.set(fileId, request);
    return request;
  }

  /** Already-resolved URL, for a first paint with no flash. */
  peek(fileId: ID): string | undefined {
    return this.urls.get(fileId);
  }

  dispose(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.inflight.clear();
  }
}
