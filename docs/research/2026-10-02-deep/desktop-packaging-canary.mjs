/** Synthetic dependency fixture exercises the installed production file collector. */
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, symlink, readdir, rm } from "node:fs/promises";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const { build, Platform } = desktopRequire("electron-builder");
const asarName = (await readdir(resolve(root, "node_modules/.pnpm"))).find((name) =>
  name.startsWith("@electron+asar@"),
);
const asar = desktopRequire(
  resolve(root, "node_modules/.pnpm", asarName, "node_modules/@electron/asar"),
);
const electronDist = dirname(desktopRequire("electron"));
const directory = await mkdtemp(join(tmpdir(), "gatherline-desktop-package-audit-"));
const project = join(directory, "project");
const dependency = join(directory, "workspace-server");
const summary = {
  capturedAt: new Date().toISOString(),
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
  }).trim(),
  scope:
    "Minimal synthetic desktop fixture with the current files:[out/**,package.json] policy and a linked workspace production dependency. No actual workspace data or source is copied. This validates collector behavior, not a fresh full Gatherline package.",
  electronBuilderVersion: desktopRequire("electron-builder/package.json").version,
  electronVersion: desktopRequire("electron/package.json").version,
};
function assertOwned() {
  const within = relative(resolve(tmpdir()), resolve(directory));
  if (
    !within ||
    within.startsWith("..") ||
    isAbsolute(within) ||
    !directory.includes("gatherline-desktop-package-audit-")
  )
    throw new Error("Unsafe disposable directory");
}
try {
  assertOwned();
  await mkdir(join(project, "out/main"), { recursive: true });
  await mkdir(join(project, "node_modules/@slackoss"), { recursive: true });
  await mkdir(join(dependency, "src"), { recursive: true });
  await mkdir(join(dependency, "data/files"), { recursive: true });
  await mkdir(join(dependency, ".turbo"), { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      name: "desktop-packaging-audit",
      version: "0.1.0",
      private: true,
      description: "Synthetic audit fixture",
      author: "Audit",
      main: "out/main/index.js",
      dependencies: { "@slackoss/server": "file:../workspace-server" },
    }),
  );
  await writeFile(
    join(project, "out/main/index.js"),
    "require('electron').app.whenReady().then(()=>require('electron').app.quit());\n",
  );
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "@slackoss/server",
      version: "0.1.0",
      private: true,
      type: "module",
      exports: { ".": "./src/index.ts" },
    }),
  );
  await writeFile(join(dependency, "src/index.ts"), "export const auditOnly = true;\n");
  const syntheticFiles = [
    "data/workspace.db",
    "data/workspace.db-wal",
    "data/workspace.db-shm",
    "data/files/synthetic-attachment",
    ".turbo/turbo-test.log",
  ];
  for (const path of syntheticFiles)
    await writeFile(join(dependency, path), `SYNTHETIC-DESKTOP-PACKAGING-CANARY:${path}\n`);
  await symlink(dependency, join(project, "node_modules/@slackoss/server"), "junction");
  await build({
    projectDir: project,
    targets: Platform.WINDOWS.createTarget("dir"),
    config: {
      appId: "dev.slackoss.desktop.audit",
      productName: "Desktop packaging audit",
      directories: { output: join(directory, "release") },
      files: ["out/**", "package.json"],
      asar: true,
      electronDist,
      electronVersion: summary.electronVersion,
      npmRebuild: false,
      win: { target: "dir", signAndEditExecutable: false },
    },
  });
  const archive = join(directory, "release/win-unpacked/resources/app.asar");
  const entries = asar
    .listPackage(archive)
    .map((path) => path.replaceAll("\\", "/").replace(/^\//, ""));
  summary.syntheticFileResults = syntheticFiles.map((path) => ({
    path,
    included: entries.includes(`node_modules/@slackoss/server/${path}`),
  }));
  summary.archiveEntries = entries;
} finally {
  assertOwned();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  summary.disposableDataCleaned = true;
}
await writeFile(
  join(here, "desktop-packaging-canary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    report: "docs/research/2026-10-02-deep/desktop-packaging-canary.json",
    syntheticFileResults: summary.syntheticFileResults,
  }),
);
