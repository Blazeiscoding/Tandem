#!/usr/bin/env node
/**
 * Refuses a built browser client whose compressed copies are missing or stale
 * (REV-13). The server sends `index-….js.br` to a browser that accepts Brotli
 * without looking at `index-….js`, so a copy that decodes to anything else is
 * a different program for some visitors. Every text file the build compresses
 * must have both copies, each must decode to exactly the file beside it, and
 * no copy may be left without its file. Prints what compression saves.
 *
 *   node scripts/check-web-precompressed.mjs [built client directory]
 *
 * Defaults to apps/web/dist. Matches apps/web/precompress.ts, which writes them.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

export const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".svg",
  ".json",
  ".txt",
  ".map",
]);
export const MIN_BYTES = 1024;
const COPIES = [
  { suffix: ".br", name: "Brotli", decode: brotliDecompressSync },
  { suffix: ".gz", name: "gzip", decode: gunzipSync },
];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/** What is wrong with the compressed copies under `dir`, and what they save. */
export function inspect(dir) {
  const problems = [];
  const totals = { files: 0, bytes: 0, br: 0, gz: 0 };
  const name = (path) => relative(dir, path).split(sep).join("/");
  for (const path of walk(dir)) {
    const copy = COPIES.find(({ suffix }) => path.endsWith(suffix));
    if (copy) {
      if (!existsSync(path.slice(0, -copy.suffix.length)))
        problems.push(`${name(path)}: a ${copy.name} copy of a file that is not there`);
      continue;
    }
    if (!COMPRESSIBLE.has(extname(path))) continue;
    const source = readFileSync(path);
    if (source.length < MIN_BYTES) continue;
    totals.files++;
    totals.bytes += source.length;
    for (const { suffix, name: encoding, decode } of COPIES) {
      const copyPath = path + suffix;
      if (!existsSync(copyPath)) {
        problems.push(`${name(path)}: no ${encoding} copy`);
        continue;
      }
      const compressed = readFileSync(copyPath);
      let decoded;
      try {
        decoded = decode(compressed);
      } catch {
        problems.push(`${name(copyPath)}: not valid ${encoding}`);
        continue;
      }
      if (!decoded.equals(source))
        problems.push(`${name(copyPath)}: decodes to something other than ${name(path)}`);
      totals[suffix === ".br" ? "br" : "gz"] += compressed.length;
    }
  }
  return { problems, totals };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2] ?? "apps/web/dist";
  const { problems, totals } = inspect(dir);
  const kB = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;
  if (totals.files === 0) problems.push("nothing to compress: is this a built client?");
  console.log(
    `${dir}: ${totals.files} files, ${kB(totals.bytes)}; Brotli ${kB(totals.br)}, gzip ${kB(totals.gz)}`,
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("Rebuild the client: its compressed copies do not match what it serves.");
    process.exit(1);
  }
}
