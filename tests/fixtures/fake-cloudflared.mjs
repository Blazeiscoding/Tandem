// Stands in for Cloudflare's cloudflared in tests, printing what a quick
// tunnel prints without reaching the internet. FAKE_CLOUDFLARED_MODE picks
// what happens:
//
//   open        the address, then a registered connection; runs until killed
//   refused     Cloudflare refuses the tunnel and cloudflared exits
//   no-connect  the address, but no connection ever registers
//   drop        opens, then exits on its own a moment later
//   named       a saved connector: a registered connection and no address
//   token-bad   a saved connector that quotes its own token and exits
//
// FAKE_CLOUDFLARED_ARGS, when set, is a file the arguments are written to.
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_CLOUDFLARED_MODE ?? "open";
const address = process.env.FAKE_CLOUDFLARED_URL ?? "https://fake-open-to-all.trycloudflare.com";
if (process.env.FAKE_CLOUDFLARED_ARGS) {
  writeFileSync(process.env.FAKE_CLOUDFLARED_ARGS, JSON.stringify(process.argv.slice(2)));
}

const log = (level, message) => process.stderr.write(`2026-09-19T12:00:00Z ${level} ${message}\n`);

// A connector started from a token file is told its address by Cloudflare, so
// it never prints one. Its complaints can quote the credentials it was given.
if (mode === "named" || mode === "token-bad") {
  log("INF", "Starting tunnel tunnelID=8f2b1c6e-5d4a-4c2b-9f01-6a3d8e7b2c15");
  if (mode === "token-bad") {
    const token = process.env.FAKE_CLOUDFLARED_TOKEN ?? "eyJhIjoiSECRETtoken";
    log("ERR", `Couldn't start tunnel error="invalid credentials" token=${token}`);
    process.exit(1);
  }
} else {
  log("INF", "Requesting new quick Tunnel on trycloudflare.com...");
  if (mode === "refused") {
    log(
      "ERR",
      'Error requesting new quick Tunnel error="failed to request quick Tunnel: 429 Too Many Requests"',
    );
    process.exit(1);
  }
  log(
    "INF",
    "+--------------------------------------------------------------------------------------------+",
  );
  log(
    "INF",
    "|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
  );
  log("INF", `|  ${address.padEnd(90)}|`);
  log(
    "INF",
    "+--------------------------------------------------------------------------------------------+",
  );
}
if (mode !== "no-connect") {
  setTimeout(() => {
    log(
      "INF",
      "Registered tunnel connection connIndex=0 event=0 ip=198.41.200.13 location=test protocol=quic",
    );
    if (mode === "drop") {
      setTimeout(() => {
        log("ERR", 'Connection terminated error="the tunnel was closed by the test"');
        process.exit(1);
      }, 150);
    }
  }, 100);
}
// Runs until the app ends it, as the real one does.
setInterval(() => {}, 60_000);
