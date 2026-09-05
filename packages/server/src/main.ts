import { parseArgs } from "node:util";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "@slackoss/protocol";
import { createWorkspaceServer, SERVER_VERSION } from "./server.js";
import { parseIceServers } from "./rtc.js";

const { values } = parseArgs({
  options: {
    data: { type: "string", default: "./data" },
    port: { type: "string", default: String(DEFAULT_PORT) },
    host: { type: "string", default: "0.0.0.0" },
    name: { type: "string" },
    "invite-only": { type: "boolean" },
    "no-mdns": { type: "boolean", default: false },
    web: { type: "string" },
    "public-url": { type: "string" },
    "allow-private-hooks": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`slackoss-server v${SERVER_VERSION}

Usage: slackoss-server [options]

  --data <dir>      Data directory (default ./data)
  --port <port>     Port to listen on (default ${DEFAULT_PORT})
  --host <host>     Host to bind (default 0.0.0.0)
  --name <name>     Workspace name (persisted on first run)
  --invite-only     Require an invite code to register
  --no-mdns         Do not advertise on the local network
  --web <dir>       Serve the browser client from this directory
  --public-url <u>  How others reach this server, e.g. https://chat.team.dev
                    (set it behind a reverse proxy; used in URLs given to apps)

  --allow-private-hooks
                    Let slash commands and event subscriptions call private
                    addresses (192.168.x, 10.x, localhost). Off by default:
                    this server can reach your whole LAN, and an admin-typed
                    URL should not become a way to probe it. Turn it on when
                    your bots really do run on the same network.
`);
  process.exit(0);
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

const server = await createWorkspaceServer({
  dataDir: resolve(values.data),
  port: Number(values.port),
  host: values.host,
  workspaceName: values.name,
  inviteOnly: values["invite-only"],
  mdns: !values["no-mdns"],
  webDistPath,
  publicUrl: values["public-url"],
  allowPrivateHooks: values["allow-private-hooks"],
  logger: true,
  iceServers: parseIceServers(process.env.SLACKOSS_ICE_SERVERS),
});

console.log(`\n  SlackOSS server v${SERVER_VERSION} is running`);
console.log(`  Data: ${resolve(values.data)}`);
console.log(`  Local:   http://localhost:${server.port}`);
for (const addr of lanAddresses()) {
  console.log(`  Network: http://${addr}:${server.port}  <- share this with your team`);
}
console.log("");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
