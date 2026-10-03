import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createWorkspaceServer } from "../../../packages/server/src/server.js";

// One malformed percent-encoding exercises the logger's input handling.
// This uses only a disposable in-memory child and ordinary health requests.
async function child(logged: boolean) {
  const stream = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: logged ? { stream } : false,
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const initial = await fetch(base + "/api/health", { signal: AbortSignal.timeout(3000) });
    assert.equal(initial.status, 200);
    console.log("valid-initial", initial.status);
    const malformed = await fetch(base + "/api/health?%=x", { signal: AbortSignal.timeout(3000) });
    console.log("malformed-query", malformed.status);
    const after = await fetch(base + "/api/health", { signal: AbortSignal.timeout(3000) });
    assert.equal(after.status, 200);
    console.log("valid-after", after.status);
  } finally {
    await server.stop();
  }
}

if (process.argv.includes("--child")) {
  await child(process.argv.includes("--logged"));
} else {
  const cases: any[] = [];
  for (const logged of [false, true]) {
    cases.push(
      await new Promise((resolve) => {
        const processChild = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            fileURLToPath(import.meta.url),
            "--child",
            ...(logged ? ["--logged"] : []),
          ],
          {
            cwd: fileURLToPath(new URL("../../../packages/server", import.meta.url)),
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        const timeout = setTimeout(() => processChild.kill(), 9000);
        processChild.stdout.on("data", (data) => (stdout += data));
        processChild.stderr.on("data", (data) => (stderr += data));
        processChild.once("exit", (exitCode, signal) => {
          clearTimeout(timeout);
          resolve({ logged, exitCode, signal, stdout, stderr });
        });
      }),
    );
  }
  assert.equal(cases[0].exitCode, 0);
  assert.ok(cases[0].stdout.includes("valid-after 200"));
  assert.equal(cases[1].exitCode, 1);
  assert.ok(cases[1].stdout.includes("valid-initial 200"));
  assert.ok(cases[1].stderr.includes("URIError: URI malformed"));
  const report = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    completedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    diagnosticPass: true,
    cases,
  };
  writeFileSync(
    new URL("server-logging-control.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
