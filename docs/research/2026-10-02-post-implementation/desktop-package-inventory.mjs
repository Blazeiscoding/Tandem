/** Metadata/manifest inventory of the coordinated fresh unpacked package. */
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const { listAsar, inventory, findForbidden } = await import(
  pathToFileURL(join(root, "scripts/check-desktop-archive.mjs"))
);
const { readAsarFile, check } = await import(
  pathToFileURL(join(root, "scripts/build-identity.mjs"))
);
const require = createRequire(join(root, "package.json"));
const ts = require("typescript");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  windowsHide: true,
  encoding: "utf8",
}).trim();
const archive = join(root, "apps/desktop/release/win-unpacked/resources/app.asar");
const files = listAsar(archive);
const report = {
  revision,
  capturedAt: new Date().toISOString(),
  scope:
    "Fresh coordinated win-unpacked package, no installer/registry operations; archive paths/sizes and build manifests only",
  archiveBytes: (await stat(archive)).size,
  archive: inventory(files),
  forbidden: findForbidden(files),
  packagedIdentity: JSON.parse(readAsarFile(archive, "out/build.json")),
  packagedWebIdentity: JSON.parse(
    await readFile(
      join(root, "apps/desktop/release/win-unpacked/resources/web/build.json"),
      "utf8",
    ),
  ),
  sourceFreshnessProblems: check(["desktop"], root),
  worker: {},
};
const main = join(root, "apps/desktop/out/main");
const worker = (await readdir(main)).find((name) => /^backupWorker-.*\.js$/.test(name));
const visited = new Set();
const modules = [];
const externals = new Set();
async function walk(path) {
  if (visited.has(path)) return;
  visited.add(path);
  const text = await readFile(path, "utf8");
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = ast.statements
    .filter((node) => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
    .map((node) => node.moduleSpecifier.text);
  modules.push({
    path: relative(root, path).replaceAll("\\", "/"),
    bytes: Buffer.byteLength(text),
    imports,
  });
  for (const specifier of imports) {
    if (specifier.startsWith(".")) await walk(resolve(dirname(path), specifier));
    else if (!specifier.startsWith("node:") && !["fs", "path"].includes(specifier))
      externals.add(specifier);
  }
}
await walk(join(main, worker));
report.worker = {
  modules,
  bundledBytes: modules.reduce((sum, module) => sum + module.bytes, 0),
  externalPackages: [...externals].sort(),
};
await writeFile(
  join(here, "desktop-package-inventory.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    report: "docs/research/2026-10-02-post-implementation/desktop-package-inventory.json",
    forbidden: report.forbidden.length,
    freshnessProblems: report.sourceFreshnessProblems.length,
    archiveBytes: report.archiveBytes,
    workerBytes: report.worker.bundledBytes,
    workerPackages: report.worker.externalPackages,
  }),
);
