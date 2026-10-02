/** Compare actual static transfer headers/bytes with a disposable precompressed candidate. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { get } from "node:http";
import {
  gzipSync,
  gunzipSync,
  brotliCompressSync,
  brotliDecompressSync,
  constants,
} from "node:zlib";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const requireServer = createRequire(join(repo, "packages/server/package.json"));
const Fastify = requireServer("fastify");
const staticPlugin = requireServer("@fastify/static");
const liveBase = process.argv.find((arg) => arg.startsWith("--base="))?.slice(7);
if (!liveBase || new URL(liveBase).hostname !== "127.0.0.1")
  throw new Error("Pass --base=http://127.0.0.1:<disposable-workspace-port>");
const bytesHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = resolve(tmpdir());
const directory = mkdtempSync(join(root, "tandem-deep-assets-"));
function owned() {
  const inside = relative(root, resolve(directory));
  if (
    !inside ||
    inside.startsWith("..") ||
    isAbsolute(inside) ||
    dirname(resolve(directory)) !== root ||
    !directory.startsWith(join(root, "tandem-deep-assets-"))
  )
    throw new Error("Unexpected disposable static directory");
}
owned();
function raw(path, encoding) {
  return new Promise((done, reject) => {
    const request = get(path, { headers: { "accept-encoding": encoding } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        done({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
      response.on("error", reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error("Static probe timeout")));
    request.on("error", reject);
  });
}
const candidate = Fastify({ logger: false });
try {
  mkdirSync(join(directory, "assets"));
  const dist = join(repo, "apps/web/dist");
  writeFileSync(join(directory, "index.html"), readFileSync(join(dist, "index.html")));
  const names = readdirSync(join(dist, "assets")).filter((name) => /\.(js|css)$/.test(name));
  for (const name of names) {
    const bytes = readFileSync(join(dist, "assets", name));
    const target = join(directory, "assets", name);
    writeFileSync(target, bytes);
    writeFileSync(`${target}.gz`, gzipSync(bytes));
    writeFileSync(
      `${target}.br`,
      brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
    );
  }
  await candidate.register(staticPlugin, {
    root: directory,
    preCompressed: true,
    setHeaders(response, filePath) {
      response.header(
        "cache-control",
        filePath.includes(`${join(directory, "assets")}`)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0",
      );
    },
  });
  await candidate.listen({ host: "127.0.0.1", port: 0 });
  const candidateBase = `http://127.0.0.1:${candidate.server.address().port}`;
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const entries = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css))"/g)].map(
    (match) => match[1],
  );
  const assets = [];
  for (const path of entries) {
    const expected = readFileSync(join(dist, path.replace(/^\//, "")));
    const baseline = await raw(liveBase + path, "br, gzip");
    const trials = [];
    for (const encoding of ["identity", "gzip", "br"]) {
      const response = await raw(candidateBase + path, encoding);
      const decoded =
        response.headers["content-encoding"] === "gzip"
          ? gunzipSync(response.body)
          : response.headers["content-encoding"] === "br"
            ? brotliDecompressSync(response.body)
            : response.body;
      if (response.status !== 200 || bytesHash(decoded) !== bytesHash(expected))
        throw new Error("Candidate served different static content");
      trials.push({
        requestedEncoding: encoding,
        encoding: response.headers["content-encoding"] ?? null,
        wireBodyBytes: response.body.length,
        decodedBodyBytes: decoded.length,
        cacheControl: response.headers["cache-control"],
        vary: response.headers.vary ?? null,
        identicalDecodedContent: true,
      });
    }
    assets.push({
      path,
      originalBytes: expected.length,
      baseline: {
        status: baseline.status,
        wireBodyBytes: baseline.body.length,
        encoding: baseline.headers["content-encoding"] ?? null,
        cacheControl: baseline.headers["cache-control"],
        identicalContent: bytesHash(baseline.body) === bytesHash(expected),
      },
      trials,
    });
  }
  const document = await raw(candidateBase + "/", "identity");
  if (document.headers["cache-control"]?.includes("immutable"))
    throw new Error("Candidate caches unhashed HTML indefinitely");
  const sum = (encoding) =>
    assets.reduce(
      (total, asset) =>
        total + asset.trials.find((trial) => trial.requestedEncoding === encoding).wireBodyBytes,
      0,
    );
  const baselineBytes = assets.reduce((total, asset) => total + asset.baseline.wireBodyBytes, 0);
  const result = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    capturedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform },
    scope:
      "Real HTTP bytes and headers for fresh web entry JS/CSS; existing workspace server versus isolated same-plugin precompression/cache candidate. No page-load latency comparison.",
    compression: { gzip: "Node default gzip", brotliQuality: 5 },
    assets,
    totals: {
      baselineBytes,
      gzipBytes: sum("gzip"),
      brotliBytes: sum("br"),
      gzipReductionPercent: 100 * (1 - sum("gzip") / baselineBytes),
      brotliReductionPercent: 100 * (1 - sum("br") / baselineBytes),
    },
    candidateHtmlCacheControl: document.headers["cache-control"],
    limitations: [
      "Candidate is not wired into product builds, CLI, Electron hosting or Docker",
      "No proxy/CDN compression assumption",
      "Raw HTTP body bytes exclude headers, TLS and latency",
      "Deployment must preserve CSP, private-file no-store, ETags and encoding negotiation",
    ],
  };
  writeFileSync(join(here, "root-http-assets.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result.totals));
} finally {
  await candidate.close();
  owned();
  rmSync(directory, { recursive: true, force: true });
}
