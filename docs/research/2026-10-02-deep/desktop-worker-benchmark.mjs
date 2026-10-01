/** Import-only baseline versus a disposable dependency-light diagnostic build. */
import { createRequire } from "node:module";
import { readFile, writeFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir, cpus, totalmem, release } from "node:os";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const desktopRequire = createRequire(resolve(root, "apps/desktop/package.json"));
const viteRequire = createRequire(desktopRequire.resolve("vite/package.json"));
const esbuild = viteRequire("esbuild");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  windowsHide: true,
  encoding: "utf8",
}).trim();
const directory = await mkdtemp(join(tmpdir(), "gatherline-desktop-worker-audit-"));
const verified = relative(resolve(tmpdir()), resolve(directory));
if (
  !verified ||
  verified.startsWith("..") ||
  isAbsolute(verified) ||
  !directory.includes("gatherline-desktop-worker-audit-")
)
  throw new Error("Unexpected disposable directory");
const main = resolve(root, "apps/desktop/out/main");
const current = join(
  main,
  (await readdir(main)).find((name) => /^backupWorker-.*\.js$/.test(name)),
);
const workerSource = await readFile(resolve(root, "apps/desktop/src/main/backupWorker.ts"), "utf8");
const candidateSource = workerSource.replace(
  'from "@slackoss/server"',
  'from "./packages/server/src/backup.ts"',
);
const serverSource = await readFile(resolve(root, "packages/server/src/server.ts"), "utf8");
const version = serverSource.match(/export const SERVER_VERSION = ("[^"]+")/)[1];
const candidate = join(directory, "candidate.mjs");
const built = await esbuild.build({
  stdin: {
    contents: candidateSource,
    resolveDir: root,
    sourcefile: "desktop-diagnostic-candidate.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  metafile: true,
  format: "esm",
  platform: "node",
  target: "node24",
  packages: "external",
  logLevel: "silent",
  plugins: [
    {
      name: "dependency-light-diagnostic-only",
      setup(build) {
        build.onLoad({ filter: /[\\/]packages[\\/]server[\\/]src[\\/]server\.ts$/ }, () => ({
          contents: `export const SERVER_VERSION = ${version};`,
          loader: "ts",
        }));
        build.onResolve({ filter: /^zod$/ }, () => ({
          path: pathToFileURL(desktopRequire.resolve("zod")).href,
          external: true,
        }));
      },
    },
  ],
});
await writeFile(candidate, built.outputFiles[0].text);
const wrapper = join(directory, "wrapper.mjs");
await writeFile(
  wrapper,
  [
    `import {parentPort,workerData} from 'node:worker_threads';`,
    `import {createRequire} from 'node:module';`,
    `const require=createRequire(import.meta.url);`,
    `await import(workerData.entry);`,
    `parentPort.postMessage({diagnostic:'import-complete',memory:process.memoryUsage(),cjsModules:Object.keys(require.cache).length,versions:process.versions});`,
  ].join("\n"),
);
const result = {
  capturedAt: new Date().toISOString(),
  sourceRevision: revision,
  runtime: process.versions,
  hardware: {
    cpu: cpus()[0]?.model,
    logicalProcessors: cpus().length,
    memoryBytes: totalmem(),
    osRelease: release(),
    architecture: process.arch,
  },
  scope:
    "Fresh worker isolate; import-only invalid diagnostic job exits without a filesystem/database operation. Parent process, files and OS cache stay warm across samples. This is not a production implementation or full backup benchmark.",
  candidate: {
    changes: [
      "worker imports backup.ts directly",
      "server.ts replaced in disposable bundle by its unchanged SERVER_VERSION export",
    ],
    bytes: built.outputFiles[0].contents.length,
    inputs: Object.keys(built.metafile.inputs),
    externalImports: Object.values(built.metafile.outputs).flatMap((output) =>
      output.imports.filter((entry) => entry.external).map((entry) => entry.path),
    ),
  },
  samples: [],
};
async function once(name, entry, ordinal, measured) {
  const started = performance.now();
  return new Promise((resolveSample, reject) => {
    const worker = new Worker(pathToFileURL(wrapper), {
      workerData: { kind: "desktop-audit-import-only", entry: pathToFileURL(entry).href },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Import diagnostic exceeded 15 seconds"));
    }, 15000);
    let sample;
    worker.on("message", (message) => {
      if (message.diagnostic !== "import-complete") return;
      sample = {
        name,
        ordinal,
        measured,
        initializedMs: performance.now() - started,
        heapUsedBytes: message.memory.heapUsed,
        heapTotalBytes: message.memory.heapTotal,
        externalBytes: message.memory.external,
        totalProcessRssBytes: message.memory.rss,
        cjsModuleCount: message.cjsModules,
        workerVersions: message.versions,
      };
    });
    worker.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (!sample || code !== 0)
        reject(new Error(`Worker exited before diagnostic completion (${code})`));
      else {
        sample.exitedMs = performance.now() - started;
        resolveSample(sample);
      }
    });
  });
}
try {
  for (let ordinal = 0; ordinal < 14; ordinal++) {
    const order =
      ordinal % 2
        ? [
            ["candidate", candidate],
            ["current", current],
          ]
        : [
            ["current", current],
            ["candidate", candidate],
          ];
    for (const [name, entry] of order)
      result.samples.push(await once(name, entry, ordinal, ordinal >= 2));
  }
  const percentile = (values, fraction) =>
    values.slice().sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  result.summary = {};
  for (const name of ["current", "candidate"]) {
    const samples = result.samples.filter((sample) => sample.name === name && sample.measured);
    result.summary[name] = {
      measuredSamples: samples.length,
      initializedMs: {
        p50: percentile(
          samples.map((s) => s.initializedMs),
          0.5,
        ),
        p95: percentile(
          samples.map((s) => s.initializedMs),
          0.95,
        ),
      },
      heapUsedBytes: {
        p50: percentile(
          samples.map((s) => s.heapUsedBytes),
          0.5,
        ),
        p95: percentile(
          samples.map((s) => s.heapUsedBytes),
          0.95,
        ),
      },
      cjsModuleCount: [...new Set(samples.map((s) => s.cjsModuleCount))],
    };
  }
} finally {
  const target = resolve(directory);
  const within = relative(resolve(tmpdir()), target);
  if (!within || within.startsWith("..") || isAbsolute(within))
    throw new Error("Unsafe cleanup path");
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  result.disposableDataCleaned = true;
}
await writeFile(
  join(here, "desktop-worker-benchmark.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    sourceRevision: revision,
    summary: result.summary,
    candidateBytes: result.candidate.bytes,
    report: "docs/research/2026-10-02-deep/desktop-worker-benchmark.json",
  }),
);
