import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Refuses to start when what the tests would launch was not built from the
 * checkout (IMP-08): a passing run would then say nothing about this source.
 * The check is an ES module, so it runs as its own process rather than being
 * loaded into Playwright's.
 */
export function freshBuilds(...artifacts: ("web" | "server" | "desktop")[]) {
  return () => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/build-identity.mjs"), "check", ...artifacts],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  };
}
