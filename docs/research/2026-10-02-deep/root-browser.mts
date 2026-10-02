/** Disposable real-browser fixture. Run through the server package's tsx. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createWorkspaceServer } from "../../../packages/server/src/server.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryRoot = resolve(tmpdir());
const dataDir = mkdtempSync(join(temporaryRoot, "tandem-deep-browser-"));
const inside = relative(temporaryRoot, resolve(dataDir));
if (
  !inside ||
  inside.startsWith(`..${sep}`) ||
  inside === ".." ||
  resolve(dataDir) === temporaryRoot
)
  throw new Error("Unsafe disposable fixture path");
const server = await createWorkspaceServer({
  dataDir,
  host: "127.0.0.1",
  port: 0,
  mdns: false,
  logger: false,
  rateLimits: false,
  workspaceName: "Deep review fixture",
  webDistPath: join(repo, "apps/web/dist"),
});
console.log(JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}`, dataDir }));
const input = createInterface({ input: process.stdin });
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  input.close();
  await server.stop();
  const target = resolve(dataDir);
  if (
    dirname(target) !== temporaryRoot ||
    !target.startsWith(join(temporaryRoot, "tandem-deep-browser-"))
  )
    throw new Error("Refusing to remove an unexpected fixture directory");
  rmSync(target, { recursive: true, force: true });
  console.log("Disposable browser fixture stopped and removed.");
}
input.on("line", (line) => {
  if (line.trim() === "stop") void stop();
});
input.on("close", () => void stop());
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
