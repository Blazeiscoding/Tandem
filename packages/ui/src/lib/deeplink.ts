import { DEEP_LINK_PROTOCOL, normalizeServerUrlSafe } from "./deeplinkHelpers.js";

/** What a slackoss:// link asks the app to do. */
export type DeepLink =
  | { kind: "join"; serverUrl: string; code: string | null }
  | { kind: "message"; serverUrl: string; channelId: string; messageId: string };

/**
 * Parses slackoss://join?host=…&code=… and
 * slackoss://message?host=…&channel=…&id=…
 * Returns null for anything malformed rather than throwing.
 */
export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_PROTOCOL}:`) return null;

  // slackoss://join?… parses "join" as the host, not the pathname.
  const action = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
  const host = url.searchParams.get("host");
  if (!host) return null;
  const serverUrl = normalizeServerUrlSafe(host);
  if (!serverUrl) return null;

  if (action === "join") {
    return { kind: "join", serverUrl, code: url.searchParams.get("code") };
  }
  if (action === "message") {
    const channelId = url.searchParams.get("channel");
    const messageId = url.searchParams.get("id");
    if (!channelId || !messageId) return null;
    return { kind: "message", serverUrl, channelId, messageId };
  }
  return null;
}
