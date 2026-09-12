import type { SavedServer } from "../platform.js";

/** A failed/corrupt read must not become an empty list that a later save overwrites. */
export function parseSavedServers(value: unknown): SavedServer[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error("Could not read saved sign-ins.");
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry.url !== "string" ||
      typeof entry.token !== "string" ||
      !entry.token ||
      typeof entry.workspaceName !== "string" ||
      typeof entry.handle !== "string" ||
      !Number.isFinite(entry.lastUsedAt) ||
      entry.lastUsedAt < 0
    )
      throw new Error("Could not read saved sign-ins.");
    const url = new URL(entry.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Could not read a saved workspace address.");
    return {
      url: entry.url,
      token: entry.token,
      workspaceName: entry.workspaceName,
      handle: entry.handle,
      lastUsedAt: entry.lastUsedAt,
    };
  });
}
