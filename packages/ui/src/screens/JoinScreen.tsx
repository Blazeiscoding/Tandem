import { useEffect, useMemo, useRef, useState } from "react";
import type { ServerInfo } from "@slackoss/protocol";
import { Api, ApiError, normalizeServerUrl } from "@slackoss/client-core";
import type { DiscoveredServer, HostingStatus, Platform, SavedServer } from "../platform.js";
import { BrandMark, Icon } from "../components/Icon.js";

interface Props {
  platform: Platform;
  savedServers: SavedServer[];
  /** Probe this address immediately on mount (used after "Open to LAN" starts). */
  autoProbe?: string;
  /** Prefilled from a slackoss://join link. */
  inviteCode?: string;
  onConnected: (server: SavedServer) => void;
  onForget: (url: string) => void;
  onHostClick?: () => void;
}

type Stage =
  | { view: "browse" }
  | { view: "auth"; url: string; info: ServerInfo }
  | { view: "probing"; url: string };

export function JoinScreen({
  platform,
  savedServers,
  autoProbe,
  inviteCode,
  onConnected,
  onForget,
  onHostClick,
}: Props) {
  const [stage, setStage] = useState<Stage>({ view: "browse" });
  const [lanServers, setLanServers] = useState<DiscoveredServer[]>([]);
  const [hosting, setHosting] = useState<HostingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!platform.discoverLan) return;
    return platform.discoverLan(setLanServers);
  }, [platform]);

  useEffect(() => {
    void platform.hosting?.status().then(setHosting);
  }, [platform]);

  useEffect(() => {
    if (autoProbe) void probe(autoProbe);
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
        setError(`${saved.workspaceName} isn't reachable right now.`);
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
      setError("That doesn't look like a valid address.");
      return;
    }
    setStage({ view: "probing", url });
    try {
      const info = await new Api(url).serverInfo();
      if (info.app !== "slackoss") throw new Error();
      setStage({ view: "auth", url, info });
    } catch {
      setError(`No workspace is answering at ${url.replace(/^https?:\/\//, "")}.`);
      setStage({ view: "browse" });
    }
  }

  return (
    <div className="flex h-full flex-col">
      {platform.kind === "desktop" && <div className="titlebar-drag h-10 shrink-0" />}
      <div className="flex flex-1 overflow-y-auto p-5 sm:p-10">
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
            ) : (
              <BrowseCard
                savedServers={savedServers}
                lanServers={lanServers}
                lanSupported={!!platform.discoverLan}
                probing={stage.view === "probing" ? stage.url : null}
                error={error}
                hostedPort={hosting?.running ? (hosting.port ?? null) : null}
                onSelect={probe}
                onOpenSaved={openSaved}
                onForget={onForget}
                onHostClick={onHostClick}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BrowseCard(props: {
  savedServers: SavedServer[];
  lanServers: DiscoveredServer[];
  lanSupported: boolean;
  probing: string | null;
  error: string | null;
  /** Port of the workspace this machine is hosting, if any. */
  hostedPort: number | null;
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
                meta={l.port === props.hostedPort ? "hosted here" : `v${l.serverVersion}`}
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
        {props.error && <p className="mt-2 text-sm text-alert">{props.error}</p>}
      </section>

      {props.onHostClick && (
        <p className="pt-2 text-center text-sm text-ink-dim">
          {props.hostedPort !== null ? (
            <>
              You're hosting on port{" "}
              <span className="font-mono text-copper">{props.hostedPort}</span>.{" "}
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
  // An empty workspace has nothing to sign in to, even if we remember a handle here.
  const [mode, setMode] = useState<"login" | "register">(isFirstUser ? "register" : "login");
  const [handle, setHandle] = useState(props.savedHandle ?? "");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(props.presetInviteCode ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => firstField.current?.focus(), [mode]);

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
            });
      props.onConnected({
        url: props.url,
        token: result.token,
        workspaceName: props.info.workspaceName,
        handle: result.user.handle,
        lastUsedAt: Date.now(),
      });
    } catch (err) {
      setError(errorMessage(err, mode));
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-edge bg-ground px-3 py-2.5 text-sm outline-none placeholder:text-ink-faint focus:border-copper";

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

      {isFirstUser && (
        <p className="mb-4 rounded-lg bg-mention px-3 py-2.5 text-sm text-copper">
          This workspace is brand new — the first account becomes its owner.
        </p>
      )}

      {hasUsers && (
        <div className="mb-4 flex gap-1 rounded-lg bg-ground p-1">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
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

      <form onSubmit={submit} className="space-y-3">
        <input
          ref={firstField}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="username"
          aria-label="Username"
          autoComplete="username"
          spellCheck={false}
          autoCapitalize="none"
          className={inputCls}
        />
        {mode === "register" && (
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name"
            aria-label="Display name"
            autoComplete="nickname"
            className={inputCls}
          />
        )}
        <input
          type="password"
          aria-label="Password"
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === "register" ? "Password (8+ characters)" : "Password"}
          className={inputCls}
        />
        {mode === "register" && !isFirstUser && props.info.requiresInvite && (
          <input
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder="Invite code"
            spellCheck={false}
            className={`${inputCls} font-mono`}
          />
        )}
        {error && <p className="text-sm text-alert">{error}</p>}
        <button
          type="submit"
          disabled={busy || !handle.trim() || !password}
          className="w-full rounded-lg bg-copper py-2.5 font-semibold text-ground transition-colors hover:bg-copper-deep disabled:opacity-40"
        >
          {busy ? "Connecting…" : mode === "login" ? "Sign in" : "Join workspace"}
        </button>
      </form>
    </div>
  );
}

function errorMessage(err: unknown, mode: "login" | "register"): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "invalid_credentials":
        return "Wrong username or password.";
      case "handle_taken":
        return "That username is taken — sign in instead?";
      case "invite_required":
        return "This workspace needs an invite code to join.";
      case "invalid_request":
        return mode === "register"
          ? "Usernames are lowercase letters and digits; passwords need 8+ characters."
          : "Check the username and password.";
    }
  }
  return "Could not reach the server. Check the address and try again.";
}
