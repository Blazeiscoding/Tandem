import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ServerInfo } from "@slackoss/protocol";
import { Api, ApiError, normalizeServerUrl } from "@slackoss/client-core";
import type { DiscoveredServer, HostingStatus, Platform, SavedServer } from "../platform.js";
import { BrandMark, Icon } from "../components/Icon.js";
import { connectionFailure, host, incompatibleWorkspace } from "../lib/connection.js";
import { resumeTarget } from "../lib/resume.js";

interface Props {
  platform: Platform;
  savedServers: SavedServer[];
  /** Probe this address immediately on mount (used after "Open to LAN" starts). */
  autoProbe?: string;
  /** Prefilled from an invite link. */
  inviteCode?: string;
  onConnected: (server: SavedServer) => void;
  onForget: (url: string) => void;
  onHostClick?: () => void;
  hostingStatus?: HostingStatus | null;
  hostingStatusError?: boolean;
  hostingStatusLoading?: boolean;
  lastHosted?: { workspaceName: string; port: number } | null;
}

type Stage =
  | { view: "browse" }
  | { view: "auth"; url: string; info: ServerInfo }
  | { view: "probing"; url: string };

/** Something that went wrong, and what the reader can do about it. */
interface Notice {
  text: string;
  retry?: () => void;
}

function selfOrigin(): string | null {
  if (typeof window === "undefined") return null;
  const { origin, protocol } = window.location;
  return protocol === "http:" || protocol === "https:" ? origin : null;
}

const pageProtocol = () => (typeof window === "undefined" ? undefined : window.location.protocol);

export function JoinScreen({
  platform,
  savedServers,
  autoProbe,
  inviteCode,
  onConnected,
  onForget,
  onHostClick,
  hostingStatus,
  hostingStatusError,
  hostingStatusLoading,
  lastHosted,
}: Props) {
  const [stage, setStage] = useState<Stage>({ view: "browse" });
  const [lanServers, setLanServers] = useState<DiscoveredServer[]>([]);
  const [error, setError] = useState<Notice | null>(null);
  const [selfServed, setSelfServed] = useState<{ url: string; info: ServerInfo } | null>(null);
  // Web only: whether the question "is this page served by a workspace?" has
  // been answered yet. Rendering the full list before it is answered shows a
  // screen that is about to be replaced.
  const [selfChecked, setSelfChecked] = useState(platform.kind !== "web");
  const probeAttempt = useRef(0);

  // A browser that was served *by* a workspace already knows where it is. Ask
  // that origin quietly; if it is not a workspace (a dev server, a static
  // host), nothing is shown and nothing is said.
  useEffect(() => {
    const origin = platform.kind === "web" ? selfOrigin() : null;
    if (!origin) {
      setSelfChecked(true);
      return;
    }
    let disposed = false;
    void new Api(origin)
      .serverInfo()
      .then((info) => {
        if (disposed || incompatibleWorkspace(origin, info)) return;
        setSelfServed({ url: origin, info });
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) setSelfChecked(true);
      });
    return () => {
      disposed = true;
    };
  }, [platform]);

  // With nowhere else to go, the workspace serving this page is the answer.
  useEffect(() => {
    if (!selfServed || savedServers.length > 0 || autoProbe) return;
    setStage((current) =>
      current.view === "browse"
        ? { view: "auth", url: selfServed.url, info: selfServed.info }
        : current,
    );
  }, [selfServed, savedServers.length, autoProbe]);

  useEffect(() => {
    if (!platform.discoverLan) return;
    return platform.discoverLan(setLanServers);
  }, [platform]);

  useEffect(() => {
    if (!autoProbe) return;
    // Somewhere already signed in to reconnects with those credentials, and asks
    // again only if they no longer work — reopening your own hosted workspace
    // should not mean typing the password each time.
    const saved = savedServers.find((s) => s.url === normalizeSafe(autoProbe));
    if (saved) void openSaved(saved);
    else void probe(autoProbe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoProbe]);

  /** Saved servers reconnect with their stored token; fall back to the auth card if it expired. */
  async function openSaved(saved: SavedServer) {
    setError(null);
    setStage({ view: "probing", url: saved.url });
    try {
      await new Api(saved.url, saved.token).me();
      onConnected(saved);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await probe(saved.url);
      } else {
        setError({
          text: connectionFailure({
            url: saved.url,
            error: err,
            name: saved.workspaceName,
            pageProtocol: pageProtocol(),
          }),
          retry: () => void openSaved(saved),
        });
        setStage({ view: "browse" });
      }
    }
  }

  async function probe(input: string) {
    setError(null);
    let url: string;
    try {
      url = normalizeServerUrl(input);
    } catch {
      setError({ text: "That doesn't look like a workspace address." });
      return;
    }
    const attempt = ++probeAttempt.current;
    setStage({ view: "probing", url });
    try {
      const info = await new Api(url).serverInfo();
      // A slower probe the user cancelled, or moved on from, must not win.
      if (probeAttempt.current !== attempt) return;
      const incompatible = incompatibleWorkspace(url, info);
      if (incompatible) {
        setError({ text: incompatible });
        setStage({ view: "browse" });
        return;
      }
      setStage({ view: "auth", url, info });
    } catch (err) {
      if (probeAttempt.current !== attempt) return;
      setError({
        text: connectionFailure({ url, error: err, pageProtocol: pageProtocol() }),
        retry: () => void probe(url),
      });
      setStage({ view: "browse" });
    }
  }

  /** Abandons a probe that is taking too long, without waiting for it to finish. */
  function cancelProbe() {
    probeAttempt.current++;
    setError(null);
    setStage({ view: "browse" });
  }

  return (
    <div className="flex h-full flex-col">
      {platform.kind === "desktop" && <div className="titlebar-drag h-10 shrink-0" />}
      <main className="flex flex-1 overflow-y-auto p-5 sm:p-10">
        <div className="join-layout m-auto grid w-full max-w-[1040px] overflow-hidden rounded-3xl border border-edge bg-raised/30 lg:grid-cols-2">
          <section className="join-story hidden flex-col justify-between border-r border-edge p-10 lg:flex">
            <div className="flex items-center gap-3 text-xl font-semibold tracking-tight">
              <BrandMark size={38} />
              Gatherline
            </div>
            <div className="py-14">
              <p className="mb-5 text-xs font-medium uppercase tracking-[0.2em] text-copper">
                Open source. Open doors.
              </p>
              <h2 className="text-[46px] font-semibold leading-[1.12] tracking-tight">
                Your people.
                <br />
                Your place.
                <br />
                <span className="text-copper">Your server.</span>
              </h2>
              <p className="mt-6 max-w-[320px] text-[15px] leading-7 text-ink-dim">
                A home for the conversations that move your team forward. From the office to the
                next game night.
              </p>
            </div>
            <div className="flex items-center gap-3 border-t border-edge pt-6 text-xs text-ink-dim">
              <Icon name="friends" />
              <span>Team chat, without giving up control.</span>
            </div>
          </section>
          <div className="w-full p-6 sm:p-9">
            <header className="mb-8">
              <div className="mb-6 flex items-center gap-2 text-lg font-semibold lg:hidden">
                <BrandMark />
                Gatherline
              </div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-copper">
                Make yourself at home
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">Find your workspace</h1>
              <p className="mt-2 text-sm leading-relaxed text-ink-dim">
                Connect to your team’s server, or start a space of your own.
              </p>
            </header>

            {stage.view === "auth" ? (
              <AuthCard
                url={stage.url}
                info={stage.info}
                savedHandle={savedServers.find((s) => s.url === stage.url)?.handle}
                presetInviteCode={inviteCode}
                onBack={() => setStage({ view: "browse" })}
                onConnected={onConnected}
              />
            ) : !selfChecked && savedServers.length === 0 && !autoProbe ? (
              <p className="rounded-xl border border-dashed border-edge px-4 py-8 text-center font-mono text-xs text-ink-faint">
                looking for this workspace…
              </p>
            ) : (
              <BrowseCard
                savedServers={savedServers}
                lanServers={lanServers}
                lanSupported={!!platform.discoverLan}
                probing={stage.view === "probing" ? stage.url : null}
                error={error}
                selfServed={selfServed}
                onCancelProbe={cancelProbe}
                hostingStatus={hostingStatus}
                hostingStatusError={hostingStatusError}
                hostingStatusLoading={hostingStatusLoading}
                lastHosted={lastHosted ?? null}
                platform={platform}
                onSelect={probe}
                onOpenSaved={openSaved}
                onForget={onForget}
                onHostClick={onHostClick}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * The workspace this computer hosted last, while hosting is stopped. One
 * click starts it again on its remembered port and opens the saved sign-in,
 * instead of reconnecting to a server that is not there.
 */
function ResumeHosted(props: {
  platform: Platform;
  savedServers: SavedServer[];
  hostingStatus?: HostingStatus | null;
  lastHosted: { workspaceName: string; port: number } | null;
  onSelect: (address: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const target = resumeTarget(props.savedServers, props.hostingStatus, props.lastHosted);
  if (!target || !props.platform.hosting || !props.lastHosted) return null;
  // Plain locals: narrowing does not reach into the async handler below.
  const { saved, workspaceName } = target;
  const { start } = props.platform.hosting;
  const { port } = props.lastHosted;
  const onSelect = props.onSelect;

  async function resume() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      // The remembered port keeps the saved sign-in's address working; a
      // fallback port would open somewhere the sign-in does not point.
      await start({ workspaceName, port });
      onSelect(saved.url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Hosted on this computer">
      <SectionLabel>Hosted on this computer</SectionLabel>
      <div className="rounded-xl border border-copper/40 p-4 text-sm">
        <p className="text-ink">
          <span className="font-semibold">{workspaceName}</span> isn’t running. Its messages, files
          and accounts are still on this computer.
        </p>
        {failed && (
          <p role="alert" className="mt-2 text-alert">
            Could not start hosting. Its port may be in use by something else — open Manage hosting
            to start it on another port.
          </p>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void resume()}
          className="mt-3 rounded-lg bg-copper px-4 py-2.5 font-semibold text-ground transition-colors hover:bg-copper-deep disabled:opacity-40"
        >
          {busy ? "Starting…" : `Start hosting ${workspaceName}`}
        </button>
      </div>
    </section>
  );
}

function BrowseCard(props: {
  savedServers: SavedServer[];
  lanServers: DiscoveredServer[];
  lanSupported: boolean;
  probing: string | null;
  error: Notice | null;
  /** The workspace serving this page, when a browser was opened from one. */
  selfServed: { url: string; info: ServerInfo } | null;
  onCancelProbe: () => void;
  hostingStatus?: HostingStatus | null;
  hostingStatusError?: boolean;
  hostingStatusLoading?: boolean;
  lastHosted?: { workspaceName: string; port: number } | null;
  platform: Platform;
  onSelect: (address: string) => void;
  onOpenSaved: (saved: SavedServer) => void;
  onForget: (url: string) => void;
  onHostClick?: () => void;
}) {
  const [address, setAddress] = useState("");
  const lanNotSaved = useMemo(
    () =>
      props.lanServers.filter(
        (l) => !props.savedServers.some((s) => s.url === normalizeSafe(`${l.host}:${l.port}`)),
      ),
    [props.lanServers, props.savedServers],
  );

  return (
    <div className="space-y-6">
      {props.error && (
        <div className="rounded-xl border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
          <p>{props.error.text}</p>
          {props.error.retry && (
            <button
              onClick={props.error.retry}
              className="mt-1.5 font-medium underline underline-offset-2"
            >
              Try again
            </button>
          )}
        </div>
      )}

      <ResumeHosted
        platform={props.platform}
        savedServers={props.savedServers}
        hostingStatus={props.hostingStatus}
        lastHosted={props.lastHosted ?? null}
        onSelect={props.onSelect}
      />

      {props.selfServed && (
        <section>
          <SectionLabel>This workspace</SectionLabel>
          <ul className="overflow-hidden rounded-xl border border-copper/40">
            <ServerRow
              title={props.selfServed.info.workspaceName}
              subtitle={host(props.selfServed.url)}
              meta="serving this page"
              busy={props.probing === props.selfServed.url}
              onClick={() => props.onSelect(props.selfServed!.url)}
            />
          </ul>
        </section>
      )}

      {props.savedServers.length > 0 && (
        <section>
          <SectionLabel>Your workspaces</SectionLabel>
          <ul className="overflow-hidden rounded-xl border border-edge">
            {props.savedServers.map((s) => (
              <ServerRow
                key={s.url}
                title={s.workspaceName}
                subtitle={s.url.replace(/^https?:\/\//, "")}
                meta={`@${s.handle}`}
                busy={props.probing === s.url}
                onClick={() => props.onOpenSaved(s)}
                onForget={() => props.onForget(s.url)}
              />
            ))}
          </ul>
        </section>
      )}

      <section>
        <SectionLabel>
          On your network
          {props.lanSupported && (
            <span className="ml-2 inline-block size-1.5 animate-pulse rounded-full bg-online align-middle" />
          )}
        </SectionLabel>
        {lanNotSaved.length > 0 ? (
          <ul className="overflow-hidden rounded-xl border border-edge">
            {lanNotSaved.map((l) => (
              <ServerRow
                key={`${l.host}:${l.port}`}
                title={l.name}
                subtitle={`${l.host}:${l.port}`}
                // Our own advertisement comes back over mDNS like any other.
                meta={
                  !props.hostingStatusError &&
                  props.hostingStatus?.running &&
                  l.port === props.hostingStatus.port
                    ? "hosted here"
                    : `v${l.serverVersion}`
                }
                busy={props.probing?.includes(l.host) ?? false}
                onClick={() => props.onSelect(`${l.host}:${l.port}`)}
              />
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-edge px-4 py-5 text-center text-sm text-ink-faint">
            {props.lanSupported
              ? "Scanning for workspaces on your Wi-Fi…"
              : "LAN discovery works in the desktop app."}
          </p>
        )}
      </section>

      <section>
        <SectionLabel>Direct connect</SectionLabel>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (address.trim()) props.onSelect(address);
          }}
        >
          <input
            value={address}
            aria-label="Server address"
            onChange={(e) => setAddress(e.target.value)}
            placeholder="192.168.1.42:8543 or chat.yourteam.dev"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-2.5 font-mono text-sm outline-none placeholder:text-ink-faint focus:border-copper"
          />
          <button
            type="submit"
            disabled={!address.trim() || props.probing !== null}
            className="rounded-lg bg-copper px-4 py-2.5 text-sm font-semibold text-ground transition-colors hover:bg-copper-deep disabled:opacity-40"
          >
            Connect
          </button>
        </form>
        {props.probing && (
          <p className="mt-2 flex items-center gap-2 text-sm text-ink-dim">
            <span className="font-mono text-xs">Contacting {host(props.probing)}…</span>
            <button onClick={props.onCancelProbe} className="underline underline-offset-2">
              Cancel
            </button>
          </p>
        )}
      </section>

      {props.onHostClick && (
        <p className="pt-2 text-center text-sm text-ink-dim">
          {props.hostingStatusError || props.hostingStatusLoading || !props.hostingStatus ? (
            <>
              {props.hostingStatusError
                ? "Hosting status unavailable. "
                : "Checking hosting status… "}
              <button
                onClick={props.onHostClick}
                className="font-medium text-copper hover:underline"
              >
                Manage hosting
              </button>
            </>
          ) : props.hostingStatus.running ||
            props.hostingStatus.phase === "starting" ||
            props.hostingStatus.phase === "stopping" ? (
            <>
              {props.hostingStatus.phase === "starting"
                ? "Starting your workspace… "
                : props.hostingStatus.phase === "stopping"
                  ? "Stopping your workspace… "
                  : "You're hosting on this computer. "}
              <button
                onClick={props.onHostClick}
                className="font-medium text-copper hover:underline"
              >
                Manage hosting
              </button>
            </>
          ) : (
            <>
              Nothing here yet?{" "}
              <button
                onClick={props.onHostClick}
                className="font-medium text-copper hover:underline"
              >
                Host a workspace on this computer
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function normalizeSafe(input: string): string {
  try {
    return normalizeServerUrl(input);
  } catch {
    return "";
  }
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
      {children}
    </h2>
  );
}

function ServerRow(props: {
  title: string;
  subtitle: string;
  meta: string;
  busy: boolean;
  onClick: () => void;
  onForget?: () => void;
}) {
  return (
    <li className="group border-b border-edge last:border-b-0">
      <div className="flex items-center bg-raised transition-colors hover:bg-lifted">
        <button
          onClick={props.onClick}
          disabled={props.busy}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-lifted font-semibold text-copper">
            {props.title[0]?.toUpperCase() ?? "?"}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{props.title}</span>
            <span className="block truncate font-mono text-xs text-ink-faint">
              {props.subtitle}
            </span>
          </span>
          <span className="font-mono text-xs text-ink-faint">{props.busy ? "…" : props.meta}</span>
        </button>
        {props.onForget && (
          <button
            onClick={props.onForget}
            title="Forget this workspace"
            className="mr-2 hidden rounded px-2 py-1 text-xs text-ink-faint hover:text-alert group-hover:block"
          >
            ✕
          </button>
        )}
      </div>
    </li>
  );
}

function AuthCard(props: {
  url: string;
  info: ServerInfo;
  savedHandle?: string;
  presetInviteCode?: string;
  onBack: () => void;
  onConnected: (server: SavedServer) => void;
}) {
  const hasUsers = props.info.userCount > 0;
  const isFirstUser = !hasUsers;
  // An empty workspace has nothing to sign in to, even if we remember a handle
  // here, and someone arriving with an invite has no account to sign in with.
  const [mode, setMode] = useState<"login" | "register">(
    isFirstUser || props.presetInviteCode ? "register" : "login",
  );
  const [handle, setHandle] = useState(props.savedHandle ?? "");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(props.presetInviteCode ?? "");
  const [claimCode, setClaimCode] = useState("");
  const [requiresClaim, setRequiresClaim] = useState(!!props.info.requiresClaim);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);
  /**
   * Set when the password just used was issued by someone else — an admin
   * reset, or host recovery. The workspace is closed to this account until it
   * chooses its own, so the card asks for one instead of going in.
   */
  const [mustReplace, setMustReplace] = useState<{ token: string; current: string } | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const id = useId();

  // Arrow keys move between the two tabs and leave focus on them, as in any
  // tab list. Anything else that changes the form puts the cursor in it.
  const keepTabFocus = useRef(false);
  useEffect(() => {
    if (keepTabFocus.current) keepTabFocus.current = false;
    else firstField.current?.focus();
  }, [mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const api = new Api(props.url);
    try {
      const result =
        mode === "login"
          ? await api.login({ handle: handle.trim().toLowerCase(), password })
          : await api.register({
              handle: handle.trim().toLowerCase(),
              displayName: displayName.trim() || handle.trim(),
              password,
              ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
              ...(claimCode.trim() ? { claimCode: claimCode.trim() } : {}),
            });
      if ("mustChangePassword" in result && result.mustChangePassword) {
        setMustReplace({ token: result.token, current: password });
        setBusy(false);
        return;
      }
      props.onConnected({
        url: props.url,
        token: result.token,
        workspaceName: props.info.workspaceName,
        handle: result.user.handle,
        lastUsedAt: Date.now(),
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "claim_required") setRequiresClaim(true);
      setError(errorMessage(err, mode));
      setBusy(false);
    }
  }

  async function replacePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!mustReplace) return;
    setError(null);
    if (newPassword.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Those two do not match.");
      return;
    }
    if (newPassword === mustReplace.current) {
      setError("Choose something other than the password you were given.");
      return;
    }
    setBusy(true);
    try {
      const api = new Api(props.url, mustReplace.token);
      await api.changePassword(mustReplace.current, newPassword);
      props.onConnected({
        url: props.url,
        token: mustReplace.token,
        workspaceName: props.info.workspaceName,
        handle: handle.trim().toLowerCase(),
        lastUsedAt: Date.now(),
      });
    } catch (err) {
      setError(errorMessage(err, "login"));
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-edge bg-ground px-3 py-2.5 text-sm outline-none placeholder:text-ink-faint focus:border-copper";
  const labelCls = "mb-1 block text-sm font-medium";
  const hintCls = "mt-1 text-xs text-ink-dim";

  return (
    <div className="rounded-xl border border-edge bg-raised p-6">
      <button
        onClick={props.onBack}
        className="mb-4 text-sm text-ink-dim transition-colors hover:text-ink"
      >
        ← All workspaces
      </button>
      <h2 className="text-xl font-bold">{props.info.workspaceName}</h2>
      <p className="mb-5 mt-0.5 font-mono text-xs text-ink-faint">
        {props.url.replace(/^https?:\/\//, "")} · {props.info.userCount}{" "}
        {props.info.userCount === 1 ? "member" : "members"}
      </p>

      {mustReplace ? (
        <>
          <p className="mb-4 rounded-lg bg-mention px-3 py-2.5 text-sm text-copper">
            That password was issued to you by someone else. Choose your own to finish signing in —
            the workspace stays closed until you do.
          </p>
          <form onSubmit={replacePassword} className="space-y-3">
            <div>
              <label className={labelCls} htmlFor={`${id}-new-password`}>
                New password
              </label>
              <input
                id={`${id}-new-password`}
                autoFocus
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                aria-describedby={`${id}-new-password-hint`}
                className={inputCls}
              />
              <p id={`${id}-new-password-hint`} className={hintCls}>
                At least 8 characters.
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor={`${id}-confirm-password`}>
                Confirm new password
              </label>
              <input
                id={`${id}-confirm-password`}
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={inputCls}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-copper py-2.5 text-sm font-semibold text-ground transition-colors hover:bg-copper-deep disabled:opacity-60"
            >
              {busy ? "Saving…" : "Set password and continue"}
            </button>
          </form>
        </>
      ) : (
        <>
          {isFirstUser && (
            <p className="mb-4 rounded-lg bg-mention px-3 py-2.5 text-sm text-copper">
              This workspace is brand new — the first account becomes its owner.
            </p>
          )}

          {hasUsers && (
            <div
              role="tablist"
              aria-label="Account"
              className="mb-4 flex gap-1 rounded-lg bg-ground p-1"
              onKeyDown={(event) => {
                const next = TAB_KEYS[event.key];
                if (!next) return;
                event.preventDefault();
                if (next !== mode) {
                  keepTabFocus.current = true;
                  setMode(next);
                }
                document.getElementById(`${id}-tab-${next}`)?.focus();
              }}
            >
              {(["login", "register"] as const).map((m) => (
                <button
                  key={m}
                  id={`${id}-tab-${m}`}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  aria-controls={`${id}-account-form`}
                  tabIndex={mode === m ? 0 : -1}
                  onClick={() => setMode(m)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    mode === m ? "bg-lifted text-ink" : "text-ink-dim hover:text-ink"
                  }`}
                >
                  {m === "login" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>
          )}

          <div
            id={`${id}-account-form`}
            {...(hasUsers ? { role: "tabpanel", "aria-labelledby": `${id}-tab-${mode}` } : {})}
          >
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className={labelCls} htmlFor={`${id}-handle`}>
                  Username
                </label>
                <input
                  id={`${id}-handle`}
                  ref={firstField}
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                  className={inputCls}
                />
              </div>
              {mode === "register" && (
                <div>
                  <label className={labelCls} htmlFor={`${id}-display-name`}>
                    Display name
                  </label>
                  <input
                    id={`${id}-display-name`}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoComplete="nickname"
                    aria-describedby={`${id}-display-name-hint`}
                    className={inputCls}
                  />
                  <p id={`${id}-display-name-hint`} className={hintCls}>
                    What everyone sees. Left empty, it is your username.
                  </p>
                </div>
              )}
              <div>
                <label className={labelCls} htmlFor={`${id}-password`}>
                  Password
                </label>
                <input
                  id={`${id}-password`}
                  type="password"
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-describedby={mode === "register" ? `${id}-password-hint` : undefined}
                  className={inputCls}
                />
                {mode === "register" && (
                  <p id={`${id}-password-hint`} className={hintCls}>
                    At least 8 characters.
                  </p>
                )}
              </div>
              {mode === "register" && !isFirstUser && props.info.requiresInvite && (
                <div>
                  <label className={labelCls} htmlFor={`${id}-invite-code`}>
                    Invite code
                  </label>
                  <input
                    id={`${id}-invite-code`}
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={`${id}-invite-code-hint`}
                    className={`${inputCls} font-mono`}
                  />
                  <p id={`${id}-invite-code-hint`} className={hintCls}>
                    From whoever invited you. This workspace takes new accounts only with one.
                  </p>
                </div>
              )}
              {mode === "register" && requiresClaim && (
                <div>
                  <label className={labelCls} htmlFor="workspace-claim-code">
                    Workspace claim code
                  </label>
                  <input
                    id="workspace-claim-code"
                    type="password"
                    autoComplete="off"
                    value={claimCode}
                    onChange={(e) => setClaimCode(e.target.value)}
                    placeholder="Claim code from the host"
                    aria-describedby="workspace-claim-help"
                    spellCheck={false}
                    className={`${inputCls} font-mono`}
                  />
                  <p id="workspace-claim-help" className="mt-1 text-xs text-ink-dim">
                    Enter the code shown when the host started this workspace to create its owner
                    account.
                  </p>
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-alert">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={busy || !handle.trim() || !password}
                className="w-full rounded-lg bg-copper py-2.5 font-semibold text-ground transition-colors hover:bg-copper-deep disabled:opacity-40"
              >
                {busy ? "Connecting…" : mode === "login" ? "Sign in" : "Join workspace"}
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

/** Which tab each key moves to. With two tabs, the ends and the neighbours are the same. */
const TAB_KEYS: Record<string, "login" | "register"> = {
  ArrowLeft: "login",
  ArrowRight: "register",
  Home: "login",
  End: "register",
};

function errorMessage(err: unknown, mode: "login" | "register"): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "invalid_credentials":
        return "Wrong username or password.";
      case "handle_taken":
        return "That username is taken — sign in instead?";
      case "invite_required":
        return "This workspace needs an invite code to join.";
      case "claim_required":
        return "Enter the workspace claim code shown on the host. The code you entered was not accepted.";
      case "invalid_request":
        return mode === "register"
          ? "Usernames are lowercase letters and digits; passwords need 8+ characters."
          : "Check the username and password.";
    }
  }
  return "Could not reach the server. Check the address and try again.";
}
