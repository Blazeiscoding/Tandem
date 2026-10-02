import { execFileSync } from "node:child_process";
import { readFileSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem, release } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const packages = [
  ["protocol", "packages/protocol"],
  ["server", "packages/server"],
  ["client-core", "packages/client-core"],
  ["ui", "packages/ui"],
  ["desktop", "apps/desktop"],
];
const units = packages.map(([name, path]) => {
  const log = readFileSync(join(root, path, ".turbo/turbo-test.log"), "utf8").replace(
    /\x1b\[[0-9;]*m/g,
    "",
  );
  const match = log.match(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/);
  if (!match) throw new Error("Missing test summary for " + name);
  return {
    name,
    passed: Number(match[1]),
    skipped: Number(match[2] ?? 0),
    logPath: path + "/.turbo/turbo-test.log",
  };
});
const artifact = (manifest, assets) => {
  const entry = readdirSync(join(root, assets)).find((p) => /^index-.*\.js$/.test(p));
  return {
    manifest: read(manifest),
    entry: join(assets, entry),
    entryBytes: statSync(join(root, assets, entry)).size,
  };
};
const result = {
  revision: git("rev-parse", "HEAD"),
  capturedAt: new Date().toISOString(),
  machine: {
    cpu: cpus()[0]?.model,
    logicalCores: cpus().length,
    memoryGiB: totalmem() / 2 ** 30,
    os: release(),
    node: process.version,
    pnpm: "10.23.0",
  },
  sourceChanges: git("diff", "--name-only", "HEAD"),
  scope:
    "Post-implementation investigation; application source unchanged. Command outcomes below are recorded from this turn's root executions; unit counts and manifests also read from resulting artifacts. No installer/registry/publish operations.",
  commands: [
    { command: "pnpm install --frozen-lockfile", exitCode: 0 },
    {
      command: "pnpm exec turbo run typecheck build --concurrency=2 --force",
      exitCode: 0,
      tasks: 10,
      cacheHits: 0,
      seconds: 22.1,
    },
    { command: "pnpm typecheck:automation", exitCode: 0 },
    {
      command:
        "VITEST_MAX_THREADS=2 VITEST_MAX_FORKS=2 pnpm exec turbo run test --concurrency=2 --force",
      exitCode: 0,
      tasks: 6,
      cacheHits: 0,
      seconds: 119.055,
    },
    {
      command:
        "node --test scripts/build-identity.test.mjs scripts/check-desktop-archive.test.mjs scripts/check-web-precompressed.test.mjs scripts/release-manifest.test.mjs scripts/desktop-ci-mode.test.mjs",
      exitCode: 0,
      passed: 22,
      failed: 0,
    },
    { command: "pnpm test:e2e", exitCode: 0, passed: 20, secondsApproximately: 108 },
    { command: "node scripts/check-ci-cache.mjs", exitCode: 0, mutations: 15, assertions: 101 },
    {
      command: "prettier --check --ignore-unknown on git ls-files in bounded batches",
      exitCode: 0,
      trackedFiles: git("ls-files").split("\n").length,
    },
    {
      command: "web bundle + desktop bundle + web/CLI compression + source identity guards",
      exitCode: 0,
    },
    {
      command: "pnpm audit --prod --json",
      exitCode: 0,
      knownVulnerabilities: 0,
      productionDependencies: 95,
    },
  ],
  units,
  unitPassed: units.reduce((n, p) => n + p.passed, 0),
  unitSkipped: units.reduce((n, p) => n + p.skipped, 0),
  skips: [
    "Windows alternate-path workspace ownership case",
    "Optional MEASURE_ROWS DOM profiling case",
  ],
  artifacts: {
    web: artifact("apps/web/dist/build.json", "apps/web/dist/assets"),
    desktop: artifact("apps/desktop/out/build.json", "apps/desktop/out/renderer/assets"),
    server: read("apps/server-cli/dist/build.json"),
    package: read("docs/research/2026-10-02-post-implementation/desktop-package-inventory.json"),
  },
  independentDiagnostics: {
    client: { node: 7, dom: 7 },
    server: { modes: 11, intentionalUncaughtChildren: 3 },
    desktop:
      "see desktop-native.json, desktop-fixtures.json and desktop-install-fixture.json; all synthetic",
  },
  browserFixture: {
    stopped: true,
    ownedTempRemoved: true,
    evidence: "root-browser-notification.json",
    screenshot: "root-notification-after-corruption.png",
  },
  limits: [
    "Docker CLI exists but Linux engine named pipe unavailable; no fresh container run",
    "Fresh unpacked package tested; no genuine installer/registry/upgrade/uninstall run",
    "No actual release/tag/publish or signing validation",
    "No screen reader/physical-device/low-spec/GPU reference acceptance",
  ],
  performance:
    "Two mixed observations and two stable search comparisons; see root-performance.md for methodology and rejected candidates.",
};
writeFileSync(join(here, "root-validation.json"), JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify({
    revision: result.revision,
    passed: result.unitPassed,
    skipped: result.unitSkipped,
    sourceChanges: result.sourceChanges,
  }),
);
