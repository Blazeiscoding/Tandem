/** Disposable boundary checks for identity, archive and release tooling. */
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const { ARTIFACTS, inputsHash, staleness, check } = await import(
  pathToFileURL(join(root, "scripts/build-identity.mjs"))
);
const { prepareRelease } = await import(pathToFileURL(join(root, "scripts/release-manifest.mjs")));
const { listFolder, findForbidden, inventory } = await import(
  pathToFileURL(join(root, "scripts/check-desktop-archive.mjs"))
);
const inspect = (path) => {
  const files = listFolder(path);
  return { ...inventory(files), forbidden: findForbidden(files) };
};
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  windowsHide: true,
  encoding: "utf8",
}).trim();
const directory = await mkdtemp(join(tmpdir(), "tandem-desktop-post-fixtures-"));
const owned = () => {
  const within = relative(resolve(tmpdir()), resolve(directory));
  if (
    !within ||
    within.startsWith("..") ||
    isAbsolute(within) ||
    !directory.includes("tandem-desktop-post-fixtures-")
  )
    throw new Error("Unsafe owned fixture directory");
};
const report = {
  revision,
  capturedAt: new Date().toISOString(),
  mode: "disposable-source-tooling-fixtures",
  cases: [],
};
async function put(path, bytes) {
  const target = join(directory, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  owned();
  const sourceFiles = {
    "package.json": '{"name":"synthetic-fixture","version":"0.1.0"}',
    "pnpm-lock.yaml": "lockfileVersion: 9.0\n",
    "tsconfig.base.json": '{"compilerOptions":{"strict":true}}',
    "pnpm-workspace.yaml": "packages: [apps/*, packages/*]\n",
    ".npmrc": "auto-install-peers=true\n",
    ".pnpmfile.cjs": "module.exports={hooks:{}};\n",
    "scripts/build-identity.mjs": "export const fixture=true;\n",
    "apps/web/src/entry.ts": "export const fixture=true;\n",
    "packages/ui/src/entry.ts": "export const fixture=true;\n",
    "apps/desktop/src/main/entry.ts": "export const fixture=true;\n",
    "apps/server-cli/entry.ts": "export const fixture=true;\n",
    "packages/server/src/entry.ts": "export const fixture=true;\n",
    "packages/protocol/src/entry.ts": "export const fixture=true;\n",
  };
  for (const [path, bytes] of Object.entries(sourceFiles)) await put(path, bytes);
  const identities = Object.fromEntries(
    Object.entries(ARTIFACTS).map(([name, spec]) => [
      name,
      {
        version: "0.1.0",
        revision,
        dirty: false,
        inputs: inputsHash(spec.inputs, directory),
        builtAt: "2026-10-02T00:00:00.000Z",
      },
    ]),
  );
  for (const path of [
    "pnpm-workspace.yaml",
    ".npmrc",
    ".pnpmfile.cjs",
    "scripts/build-identity.mjs",
    "pnpm-lock.yaml",
    "apps/web/src/entry.ts",
  ]) {
    await put(path, sourceFiles[path] + "\n# synthetic-change\n");
    report.cases.push({
      name: "input-mutation",
      path,
      artifacts: Object.entries(ARTIFACTS).map(([name, spec]) => ({
        artifact: name,
        changedHash: inputsHash(spec.inputs, directory) !== identities[name].inputs,
        staleness: staleness(name, JSON.stringify(identities[name]), directory),
      })),
    });
    await put(path, sourceFiles[path]);
  }
  await put("apps/web/public/synthetic.bin", Buffer.from([0, 13, 10, 255]));
  const binaryBefore = inputsHash(ARTIFACTS.web.inputs, directory);
  await put("apps/web/public/synthetic.bin", Buffer.from([0, 10, 255]));
  const binaryAfter = inputsHash(ARTIFACTS.web.inputs, directory);
  report.cases.push({
    name: "binary-crlf-normalization",
    actualByteHashesDiffer:
      sha256(Buffer.from([0, 13, 10, 255])) !== sha256(Buffer.from([0, 10, 255])),
    sourceHashEqual: binaryBefore === binaryAfter,
  });
  await rm(join(directory, "apps/web/public/synthetic.bin"));
  await put("apps/web/dist/build.json", JSON.stringify(identities.web));
  await put("apps/web/dist/assets/entry.js", "synthetic-old-output");
  await put("apps/web/dist/assets/entry.js", "synthetic-different-output");
  report.cases.push({
    name: "manifest-not-bound-to-output-bytes",
    problems: check(["web"], directory),
    limitation:
      "Source freshness compares sidecar input metadata. This is not itself a promised artifact-integrity verifier; release provenance still needs explicit binding.",
  });
  report.cases.push({
    name: "older-revision-same-inputs",
    staleness: staleness(
      "web",
      JSON.stringify({ ...identities.web, revision: "0".repeat(40) }),
      directory,
    ),
    interpretation:
      "Content-based source freshness permits another revision with identical artifact inputs; metadata accurately identifies the original build revision. Release identity uses a separate exact-revision check.",
  });
  for (const text of ["null", "1", '{"inputs":"wrong","revision":1}']) {
    let outcome;
    try {
      outcome = { result: staleness("web", text, directory) };
    } catch (error) {
      outcome = { throws: error.name, message: error.message };
    }
    report.cases.push({ name: "malformed-manifest-shape", text, outcome });
  }
  const stage = join(directory, "release");
  await mkdir(stage);
  await writeFile(join(stage, "desktop.build.json"), JSON.stringify(identities.desktop));
  await writeFile(
    join(stage, "synthetic-installer.exe"),
    "not an executable; synthetic stale-asset marker\n",
  );
  const first = prepareRelease({ dir: stage, revision, tag: "v0.1.0" });
  report.cases.push({
    name: "release-sidecar-independent-of-asset",
    acceptedFiles: first.files,
    limitation:
      "Synthetic non-executable fixture: this proves prepareRelease trusts separate identities and does not validate a file-to-identity mapping; it is not a published-release exploit.",
  });
  await writeFile(join(stage, "SHA256SUMS"), first.sums);
  await writeFile(join(stage, "notes.md"), first.notes);
  const second = prepareRelease({ dir: stage, revision, tag: "v0.1.0" });
  const oldNotesHash = sha256(first.notes);
  const newNotesHash = sha256(second.notes);
  report.cases.push({
    name: "release-tool-repeat",
    firstFiles: first.files,
    secondFiles: second.files,
    sumsIncludesNotes: second.sums.includes("  notes.md"),
    notesHashRecorded: oldNotesHash,
    rewrittenNotesHash: newNotesHash,
    noteChecksumStaysValid: oldNotesHash === newNotesHash,
  });
  // A clean folder control and forbidden filenames, without archive/data contents.
  const archiveFixture = join(directory, "archive");
  await mkdir(archiveFixture);
  await writeFile(join(archiveFixture, "entry.js"), "export const fixture=true;\n");
  const clean = inspect(archiveFixture);
  await mkdir(join(archiveFixture, "data/files"), { recursive: true });
  await writeFile(join(archiveFixture, "data/files/attachment"), "synthetic-attachment");
  await writeFile(join(archiveFixture, "workspace.db-wal"), "synthetic-database-log");
  const dirty = inspect(archiveFixture);
  report.cases.push({ name: "archive-clean-and-canary-controls", clean, dirty });
} finally {
  owned();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  report.disposableDataCleaned = await stat(directory).then(
    () => false,
    () => true,
  );
}
await writeFile(join(here, "desktop-fixtures.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    report: "docs/research/2026-10-02-post-implementation/desktop-fixtures.json",
    cases: report.cases.length,
    cleaned: report.disposableDataCleaned,
  }),
);
