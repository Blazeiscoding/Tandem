import { parseArgs } from "node:util";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_PORT } from "@slackoss/protocol";
import { createWorkspaceServer, SERVER_VERSION } from "./server.js";

const { values } = parseArgs({
  options: {
    data: { type: "string", default: "./data" },
    port: { type: "string", default: String(DEFAULT_PORT) },
    host: { type: "string", default: "0.0.0.0" },
    name: { type: "string" },
    "invite-only": { type: "boolean" },
    "no-mdns": { type: "boolean", default: false },
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

const server = await createWorkspaceServer({
  dataDir: resolve(values.data),
  port: Number(values.port),
  host: values.host,
  workspaceName: values.name,
  inviteOnly: values["invite-only"],
  mdns: !values["no-mdns"],
  logger: true,
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
