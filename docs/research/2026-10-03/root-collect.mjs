/** Collect completed verification and format tracked files without entering private untracked folders. */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAsarFile } from "../../../scripts/build-identity.mjs";

const folder = dirname(fileURLToPath(import.meta.url));
const root = resolve(folder, "../../..");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const reviewedRevision = "cd3af584ba46adace45465cb5e5c66afb238b01c";
if (revision !== reviewedRevision)
  throw new Error("The checkout no longer matches this completed review.");

// Keep readable command outputs alongside the report: .log is ignored by the repository.
// Normalize only line endings, trailing whitespace and extra final blank lines.
for (const name of readdirSync(folder))
  if (name.endsWith(".log"))
    writeFileSync(
      join(folder, name.replace(/\.log$/, ".txt")),
      readFileSync(join(folder, name), "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/[\t ]+$/gm, "")
        .replace(/\n+$/, "\n"),
    );
for (const name of readdirSync(folder)) {
  if (!name.endsWith(".md")) continue;
  const path = join(folder, name);
  const before = readFileSync(path, "utf8");
  const after = before.replace(/\.log\)/g, ".txt)");
  if (before !== after) writeFileSync(path, after);
}

const read = (name) => JSON.parse(readFileSync(join(folder, name), "utf8"));
const manifests = [
  "apps/web/dist/build.json",
  "apps/server-cli/dist/build.json",
  "apps/server-cli/dist/web/build.json",
  "apps/desktop/out/build.json",
  "apps/desktop/release/win-unpacked/resources/web/build.json",
];
const archive = join(root, "apps/desktop/release/win-unpacked/resources/app.asar");
const builds = Object.fromEntries(
  manifests.map((name) => [name, JSON.parse(readFileSync(join(root, name), "utf8"))]),
);
builds["desktop archive:out/build.json"] = JSON.parse(readAsarFile(archive, "out/build.json"));
for (const [name, identity] of Object.entries(builds))
  if (identity.revision !== revision || identity.dirty !== false)
    throw new Error(`Unexpected built identity: ${name}`);

const entries = (dir) =>
  readdirSync(join(root, dir))
    .filter((name) => /^index-[^.]+\.js$/.test(name))
    .map((name) => ({ name, bytes: statSync(join(root, dir, name)).size }));
const mixed = [read("root-mixed-1.json"), read("root-mixed-2.json")].map((run) => ({
  params: run.params,
  sourceChanged: run.sourceChanged,
  errors: run.errors,
  posts: run.results.post.samples,
  postP50: run.results.post.p50,
  postP95: run.results.post.p95,
  exactReplays: run.replay.exact,
  replaySnapshots: run.replay.snapshots,
  expiredRemoved: run.workByRound.reduce((n, round) => n + round.expiredRemoved, 0),
  expiredFilesSeeded: run.workByRound.reduce((n, round) => n + round.expiredFilesSeeded, 0),
  eventLoopMaxMs: Math.max(...run.eventLoopDelayMsByRound.map((round) => round.max)),
  harnessReceiptsHeld: run.harness.receiptsHeld,
}));
if (mixed.some((run) => run.errors || run.sourceChanged))
  throw new Error("Mixed results do not match the reported successful unchanged source runs.");

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
let formatCode = 0;
const formatting = [];
for (let at = 0; at < tracked.length; at += 60) {
  const run = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/prettier/bin/prettier.cjs"),
      "--check",
      "--ignore-unknown",
      ...tracked.slice(at, at + 60),
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  formatting.push(run.stdout ?? "", run.stderr ?? "");
  if (run.status !== 0 || run.error) formatCode = run.status ?? 1;
}
writeFileSync(join(folder, "root-format-tracked.txt"), formatting.join(""));
const validation = {
  reviewedRevision: revision,
  capturedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  pnpm: "10.23.0",
  install: "pnpm install --frozen-lockfile: exit 0",
  productSourceChanged: false,
  buildTypecheck: {
    command: "pnpm exec turbo run typecheck build --concurrency=2 --force",
    exitCode: 0,
    successfulTasks: 10,
    cachedTasks: 0,
    projects: 7,
    output: "root-build.txt",
  },
  automationTypecheck: { command: "pnpm typecheck:automation", exitCode: 0 },
  units: {
    totalPassed: 1762,
    totalSkipped: 2,
    protocol: 27,
    server: 601,
    clientCore: 224,
    ui: 677,
    desktop: 233,
    completedReruns: true,
    firstCombinedRunExitCode: 1,
    firstFailure:
      "ownership.test.ts:149 admitted a second server while child was expected to hold the workspace; cause unresolved",
    subsequentOwnership: "8 passed / 1 skip focused; 601 passed / 1 skip full server",
    outputs: [
      "root-tests.txt",
      "root-client-desktop-tests.txt",
      "server-ownership-rerun.txt",
      "server-suite-rerun.txt",
    ],
  },
  tooling: { exitCode: 0, passed: 28, output: "root-tooling.txt" },
  browsers: { exitCode: 0, passed: 22, output: "root-e2e.txt" },
  nativeWindows: {
    exitCode: 0,
    passed: 6,
    packageMode: "fresh win-unpacked; no genuine installation",
    electron: "44.1.0",
    outputs: ["root-package.txt", "root-desktop-e2e.txt"],
  },
  cacheInputs: { exitCode: 0, mutations: 15, assertions: 101, output: "root-cache.txt" },
  productionAudit: {
    command: "pnpm audit --prod --json",
    exitCode: 0,
    knownVulnerabilities: 0,
    dependencies: 95,
  },
  bundleEntries: {
    web: entries("apps/web/dist/assets"),
    desktop: entries("apps/desktop/out/renderer/assets"),
    budgetBytes: 500000,
  },
  archive: {
    bytes: statSync(archive).size,
    files: 1163,
    dependencies: 55,
    forbiddenFileGuardExitCode: 0,
  },
  compressionGuards: {
    exitCode: 0,
    copies: [
      "apps/web/dist",
      "apps/server-cli/dist/web",
      "apps/desktop/release/win-unpacked/resources/web",
    ],
    filesPerCopy: 18,
  },
  freshness: {
    command: "node scripts/build-identity.mjs check web server desktop",
    exitCode: 0,
    builds,
  },
  mixed,
  trackedFormatting: {
    exitCode: formatCode,
    output: "root-format-tracked.txt",
    excludesUntrackedPrivateFolder: true,
  },
  limits: [
    "Docker Linux engine unavailable",
    "No genuine installed upgrade/uninstall or published/downloaded release",
    "No second-device/proxy/public-route run",
    "No screen reader or physical microphone unplug test",
    "No low-spec desktop-main/GPU reference",
    "T3 screenshot snapshot failed; no screenshot claimed",
  ],
};
writeFileSync(join(folder, "root-validation.json"), JSON.stringify(validation, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      reviewedRevision: revision,
      unitsPassed: validation.units.totalPassed,
      browsers: 22,
      nativeWindows: 6,
      mixed,
      trackedFormattingExitCode: formatCode,
    },
    null,
    2,
  ),
);
process.exitCode = formatCode;
