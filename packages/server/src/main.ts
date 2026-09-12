import { parseArgs } from "node:util";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "@slackoss/protocol";
import { createWorkspaceServer, SERVER_VERSION } from "./server.js";
import { backupWorkspace, restoreWorkspace, verifyBackup } from "./backup.js";
import { listAccounts, recoverAccount } from "./recover.js";
import { parseIceServers } from "./rtc.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string", default: "./data" },
    out: { type: "string" },
    from: { type: "string" },
    port: { type: "string", default: String(DEFAULT_PORT) },
    host: { type: "string", default: "0.0.0.0" },
    name: { type: "string" },
    "invite-only": { type: "boolean" },
    "no-mdns": { type: "boolean", default: false },
    "storage-limit-mb": { type: "string" },
    "abandoned-upload-hours": { type: "string" },
    "retention-days": { type: "string" },
    web: { type: "string" },
    "public-url": { type: "string" },
    "allow-private-hooks": { type: "boolean", default: false },
    "no-rate-limits": { type: "boolean", default: false },
    "trust-proxy": { type: "boolean", default: false },
    handle: { type: "string" },
    "make-owner": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`slackoss-server v${SERVER_VERSION}

Usage: slackoss-server [options]
       slackoss-server backup  --data <dir> --out <dir>
       slackoss-server restore --from <dir> --data <dir>
       slackoss-server verify-backup --from <dir>
       slackoss-server recover --data <dir> [--handle <handle>] [--make-owner]

  --data <dir>      Data directory (default ./data)
  --port <port>     Port to listen on (default ${DEFAULT_PORT})
  --host <host>     Host to bind (default 0.0.0.0)
  --name <name>     Workspace name (persisted on first run)
  --invite-only     Require an invite code to register
  --no-mdns         Do not advertise on the local network
  --storage-limit-mb <n>
                    Attachment storage cap in MiB; 0 is unlimited (default).
                    Also settable with SLACKOSS_STORAGE_LIMIT_MB.
  --abandoned-upload-hours <n>
                    How long an upload may sit unattached before it is freed
                    (default 24). Attachments a scheduled message still needs
                    are never swept, however old they are.
  --retention-days <n>
                    Discard conversation older than this many days; 0 keeps
                    everything (default). What it removes is removed from the
                    database, not hidden: getting it back means restoring a
                    backup taken before the sweep ran. A thread goes as one
                    thing, once its newest reply is past the window too. Also
                    settable with SLACKOSS_RETENTION_DAYS.
  --web <dir>       Serve the browser client from this directory
  --public-url <u>  How others reach this server, e.g. https://chat.team.dev
                    (set it behind a reverse proxy; used in URLs given to apps)
  --trust-proxy     Believe the X-Forwarded-* headers. Only set this when a
                    reverse proxy in front of this server writes them and
                    nothing else can reach it directly; anyone can send those
                    headers, and a forged one would decide where an app sends
                    its reply. Setting --public-url is the better answer where
                    the address is fixed, and does not require trusting anyone.

  --no-rate-limits  Do not ration requests. One caller is otherwise held to a
                    fair share of sign-in attempts, messages, uploads, sockets
                    and typing notices; limits are keyed on the account where
                    there is one, so a whole office behind a single address
                    does not share one person's allowance. Turn this off only
                    on a network where everyone is already trusted. Also
                    settable with SLACKOSS_RATE_LIMITS=off.

  --allow-private-hooks
                    Let slash commands and event subscriptions call private
                    addresses (192.168.x, 10.x, localhost). Off by default:
                    this server can reach your whole LAN, and an admin-typed
                    URL should not become a way to probe it. Turn it on when
                    your bots really do run on the same network.

Backups

  backup          Copy a workspace to a new, empty directory: the database as
                  a consistent snapshot, every attachment, and a manifest with
                  checksums and the schema version. Stop the server first for a
                  backup that is certain to be complete.
  verify-backup   Check a backup's checksums and database without restoring it.
  restore         Replace --data with a backup, after verifying it. The old
                  directory is renamed rather than deleted. Stop the server
                  before restoring.

Recovery

  recover         Get back into a workspace nobody can sign in to. Run it on
                  this machine, with the server stopped. Without --handle it
                  lists the accounts; with one it issues a temporary password
                  for that account, ends its sessions, and requires a new
                  password at next sign-in. --make-owner also hands the
                  workspace to that account, which is the way back from an
                  owner who has left. This needs the workspace file, so it
                  gives away nothing that reading the file did not already.
`);
  process.exit(0);
}

const command = positionals[0];

if (command === "backup") {
  if (!values.out) {
    console.error("backup needs --out <dir>, an empty directory to write into");
    process.exit(1);
  }
  const manifest = await backupWorkspace({
    dataDir: resolve(values.data),
    out: resolve(values.out),
  });
  const totals = Object.entries(manifest.counts)
    .map(([table, n]) => `${n} ${table.replace(/_/g, " ")}`)
    .join(", ");
  console.log(`
  Backed up "${manifest.workspaceName}" to ${resolve(values.out)}`);
  console.log(`  Schema v${manifest.schemaVersion}, ${manifest.files.length} attachments`);
  console.log(`  ${totals}
`);
  process.exit(0);
}

if (command === "verify-backup" || command === "restore") {
  if (!values.from) {
    console.error(`${command} needs --from <dir>, the backup directory`);
    process.exit(1);
  }
  try {
    if (command === "verify-backup") {
      const manifest = await verifyBackup(resolve(values.from));
      const when = new Date(manifest.createdAt).toISOString();
      console.log(`
  Backup of "${manifest.workspaceName}" is intact`);
      console.log(`  Taken ${when} by server v${manifest.serverVersion}, schema v${manifest.schemaVersion}
`);
    } else {
      const { manifest, supersededDir } = await restoreWorkspace({
        backupDir: resolve(values.from),
        dataDir: resolve(values.data),
      });
      console.log(`
  Restored "${manifest.workspaceName}" into ${resolve(values.data)}`);
      if (supersededDir) console.log(`  The previous data directory is kept at ${supersededDir}`);
      console.log("");
    }
  } catch (err) {
    console.error(`
  ${err instanceof Error ? err.message : String(err)}
`);
    process.exit(1);
  }
  process.exit(0);
}

if (command === "recover") {
  try {
    if (!values.handle) {
      const accounts = listAccounts(resolve(values.data));
      if (accounts.length === 0) {
        console.log("\n  This workspace has no accounts yet.\n");
        process.exit(0);
      }
      console.log("\n  Accounts in this workspace\n");
      for (const account of accounts) {
        const notes = [
          account.role,
          account.deactivated ? "deactivated" : null,
          account.mustChangePassword ? "must choose a new password" : null,
        ].filter(Boolean);
        console.log(`  ${account.handle.padEnd(20)} ${account.displayName} (${notes.join(", ")})`);
      }
      console.log(`
  Run again with --handle <handle> to issue a temporary password.
`);
      process.exit(0);
    }
    const result = await recoverAccount({
      dataDir: resolve(values.data),
      handle: values.handle,
      makeOwner: values["make-owner"],
    });
    console.log(`
  Temporary password for "${values.handle}" (${result.role}):

      ${result.temporaryPassword}

  ${result.revokedSessions} existing ${result.revokedSessions === 1 ? "session was" : "sessions were"} ended.
  Signing in with this password leads straight to choosing a new one; nothing
  else in the workspace is reachable until then. It is not stored anywhere, so
  copy it now.
`);
  } catch (err) {
    console.error(`
  ${err instanceof Error ? err.message : String(err)}
`);
    process.exit(1);
  }
  process.exit(0);
}

if (command !== undefined) {
  console.error(`Unknown command "${command}". Run with --help to see what is available.`);
  process.exit(1);
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

// A `web/` folder next to the executable is picked up automatically (how the
// bundled CLI and Docker image ship the browser client).
const besideScript = join(dirname(fileURLToPath(import.meta.url)), "web");
const webDistPath = values.web
  ? resolve(values.web)
  : existsSync(besideScript)
    ? besideScript
    : undefined;

/**
 * Reads a numeric setting, naming the flag someone actually typed rather than
 * letting a stray character surface as an internal option name in a stack trace.
 */
function numericOption(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`
  ${flag} needs a non-negative number, not "${raw}"
`);
    process.exit(1);
  }
  return value;
}

const storageLimitMb = numericOption(
  "--storage-limit-mb",
  values["storage-limit-mb"] ?? process.env.SLACKOSS_STORAGE_LIMIT_MB,
  0,
);
const abandonedUploadHours = numericOption(
  "--abandoned-upload-hours",
  values["abandoned-upload-hours"] ?? process.env.SLACKOSS_ABANDONED_UPLOAD_HOURS,
  24,
);
const retentionDays = numericOption(
  "--retention-days",
  values["retention-days"] ?? process.env.SLACKOSS_RETENTION_DAYS,
  0,
);
if (abandonedUploadHours <= 0) {
  console.error(`
  --abandoned-upload-hours must be greater than zero
`);
  process.exit(1);
}

const server = await createWorkspaceServer({
  dataDir: resolve(values.data),
  maxStorageBytes: Math.round(storageLimitMb * 1024 * 1024),
  abandonedUploadTtlMs: Math.round(abandonedUploadHours * 3600_000),
  retentionDays: Math.round(retentionDays),
  port: Number(values.port),
  host: values.host,
  workspaceName: values.name,
  inviteOnly: values["invite-only"],
  mdns: !values["no-mdns"],
  webDistPath,
  publicUrl: values["public-url"],
  allowPrivateHooks: values["allow-private-hooks"],
  trustProxy: values["trust-proxy"],
  rateLimits:
    values["no-rate-limits"] || process.env.SLACKOSS_RATE_LIMITS === "off" ? false : undefined,
  logger: true,
  iceServers: parseIceServers(process.env.SLACKOSS_ICE_SERVERS),
});

console.log(`\n  SlackOSS server v${SERVER_VERSION} is running`);
console.log(`  Data: ${resolve(values.data)}`);
console.log(`  Local:   http://localhost:${server.port}`);
if (retentionDays > 0) {
  // Said out loud on every start. A setting that quietly discards history is
  // one somebody should be reminded they turned on.
  console.log(`  Retention: conversation older than ${retentionDays} days is discarded`);
}
for (const addr of lanAddresses()) {
  console.log(`  Network: http://${addr}:${server.port}  <- share this with your team`);
}
if (server.claimCode) {
  console.log("");
  console.log("  This workspace has no owner yet.");
  console.log(`  Claim code: ${server.claimCode}`);
  console.log("  Creating the first account from this machine does not need it.");
  console.log("  From anywhere else, enter it when you create that account.");
}
console.log("");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
