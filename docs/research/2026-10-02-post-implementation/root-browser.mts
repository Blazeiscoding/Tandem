/** Owned loopback fixture for the shared product-native preview. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createWorkspaceServer } from "../../../packages/server/src/server.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryRoot = realpathSync(tmpdir());
const directory = realpathSync(mkdtempSync(join(temporaryRoot, "tandem-post-review-browser-")));
function owned() {
  const target = realpathSync(directory);
  const inside = relative(temporaryRoot, target);
  if (
    !inside ||
    inside.startsWith("..") ||
    isAbsolute(inside) ||
    dirname(target) !== temporaryRoot ||
    !target.startsWith(join(temporaryRoot, "tandem-post-review-browser-"))
  )
    throw new Error("Unexpected disposable fixture path");
}
owned();
const server = await createWorkspaceServer({
  dataDir: directory,
  host: "127.0.0.1",
  port: 0,
  mdns: false,
  logger: false,
  rateLimits: false,
  workspaceName: "Tandem review fixture",
  webDistPath: join(repo, "apps/web/dist"),
});
console.log(
  JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}`, directory, processId: process.pid }),
);
const input = createInterface({ input: process.stdin });
let stopped = false;
const deadline = setTimeout(
  () => {
    void stop();
  },
  45 * 60 * 1000,
);
async function stop() {
  if (stopped) return;
  stopped = true;
  clearTimeout(deadline);
  input.close();
  await server.stop();
  owned();
  rmSync(directory, { recursive: true, force: true });
  console.log("Stopped and removed owned browser fixture.");
}
input.on("line", (line) => {
  if (line.trim() === "stop") void stop();
});
input.on("close", () => void stop());
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
