import type { ID } from "@slackoss/protocol";

/** Where someone is in a workspace: a conversation, and the thread open beside it. */
export interface WorkspaceRoute {
  channelId: ID;
  threadRootId: ID | null;
}

/** Channel and message ids never contain anything else. */
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/** The key this app's part of a history entry's state sits under. */
const KEY = "gatherline";

interface RouteState {
  server: string;
  channelId: ID;
  threadRootId: ID | null;
}

/**
 * Reads "#/c/<channel>" and "#/c/<channel>/t/<thread root>". A link to one
 * message, "#/c/<channel>/m/<message>", is not a place to stay: it is handed
 * over once and taken out of the address, so it is not read here.
 */
export function parseRouteHash(hash: string): WorkspaceRoute | null {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] !== "c" || !TOKEN.test(parts[1] ?? "")) return null;
  if (parts.length === 2) return { channelId: parts[1]!, threadRootId: null };
  if (parts.length === 4 && parts[2] === "t" && TOKEN.test(parts[3]!))
    return { channelId: parts[1]!, threadRootId: parts[3]! };
  return null;
}

export function routeHash(route: WorkspaceRoute): string {
  const e = encodeURIComponent;
  return route.threadRootId
    ? `#/c/${e(route.channelId)}/t/${e(route.threadRootId)}`
    : `#/c/${e(route.channelId)}`;
}

function stateOf(state: unknown): RouteState | null {
  const value = (state as Record<string, unknown> | null)?.[KEY] as RouteState | undefined;
  if (!value || typeof value.server !== "string" || typeof value.channelId !== "string")
    return null;
  return value;
}

/** Whether this page is the web client the workspace itself serves. */
function servesPage(serverUrl: string, origin: string): boolean {
  try {
    return new URL(serverUrl).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The route this page's history entry, or failing that its address, gives
 * for this workspace. An entry remembers which workspace it belongs to, so a
 * desktop app with several never opens one workspace at another's channel.
 * An address with no entry state behind it, typed or shared into a browser,
 * can only mean the workspace serving the page.
 */
export function currentRoute(
  serverUrl: string,
  location: Pick<Location, "hash" | "origin"> = window.location,
  historyState: unknown = window.history.state,
): WorkspaceRoute | null {
  const remembered = stateOf(historyState);
  if (remembered) {
    return remembered.server === serverUrl
      ? { channelId: remembered.channelId, threadRootId: remembered.threadRootId ?? null }
      : null;
  }
  return servesPage(serverUrl, location.origin) ? parseRouteHash(location.hash) : null;
}

export function sameRoute(a: WorkspaceRoute | null, b: WorkspaceRoute | null): boolean {
  return a?.channelId === b?.channelId && (a?.threadRootId ?? null) === (b?.threadRootId ?? null);
}

/**
 * Records where someone went. Moving from one place in this workspace to
 * another adds a history entry, so Back returns to it. An entry that is not
 * yet this workspace's, such as the page as it loaded or a link just taken
 * out of the address, is replaced instead, and so is one the app moved away
 * from on its own ("replace"), so Back does not lead somewhere unavailable.
 */
export function writeRoute(
  serverUrl: string,
  route: WorkspaceRoute,
  mode: "auto" | "replace" = "auto",
): void {
  const entry = stateOf(window.history.state);
  const own = entry?.server === serverUrl;
  const here = own && sameRoute(entry, route);
  if (here && window.location.hash === routeHash(route)) return;
  const state = { [KEY]: { server: serverUrl, ...route } satisfies RouteState };
  const url = window.location.pathname + window.location.search + routeHash(route);
  // Somewhere new in this workspace is a step to go Back through. Anything
  // else, such as the same place after a link was taken out of the address,
  // rewrites the entry it is on.
  if (own && !here && mode === "auto") window.history.pushState(state, "", url);
  else window.history.replaceState(state, "", url);
}
