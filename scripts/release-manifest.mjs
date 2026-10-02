/**
 * Prepares a release from what a release run built and tested (IMP-08): the
 * SHA-256 of every file it publishes, and notes naming the revision each was
 * built from. It refuses an artifact built from any other commit, from changed
 * source, or from a version the tag does not name, so a downloaded build
 * always identifies the revision its tests ran against.
 *
 *   node scripts/release-manifest.mjs <dir> --revision <sha> --tag <tag> --notes <file> [--signed]
 *
 * In <dir>, each `<artifact>.build.json` is the identity an artifact was built
 * with, and every other file is published. `SHA256SUMS` is written into <dir>
 * (and published with the rest), the notes to <file>.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const IDENTITY = /^(.+)\.build\.json$/;
const SUMS = "SHA256SUMS";

/** Hex SHA-256 of a file. */
export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** What is wrong with one artifact's identity for this release, or null. */
export function identityProblem(name, identity, { revision, version }) {
  if (identity.revision !== revision)
    return `${name} was built from ${String(identity.revision).slice(0, 12)}, not ${revision.slice(0, 12)}`;
  if (identity.dirty !== false)
    return identity.dirty === null
      ? `${name} was built where git could not say whether its source had changed`
      : `${name} was built from source with uncommitted changes`;
  if (identity.version !== version)
    return `${name} is version ${identity.version}, but the tag names ${version}`;
  return null;
}

/** `v1.2.3` or `v1.2.3-rc.1` → `1.2.3`; null for a tag naming no version. */
export function tagVersion(tag) {
  return /^v(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(tag)?.[1] ?? null;
}

/**
 * Checks `dir` and returns the checksum file's text and the release notes.
 * Throws with every problem at once.
 */
export function prepareRelease({ dir, revision, tag, signed = false }) {
  const version = tagVersion(tag);
  const problems = [];
  if (!version) problems.push(`tag ${tag} names no version (expected v1.2.3 or v1.2.3-rc.1)`);
  if (!/^[0-9a-f]{40}$/.test(revision)) problems.push(`revision ${revision} is not a commit`);

  const identities = [];
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === SUMS || !statSync(join(dir, entry)).isFile()) continue;
    const match = IDENTITY.exec(entry);
    if (match) identities.push([match[1], JSON.parse(readFileSync(join(dir, entry), "utf8"))]);
    else files.push(entry);
  }
  if (identities.length === 0) problems.push("no artifact identity (<artifact>.build.json) found");
  if (files.length === 0) problems.push("nothing to publish");
  if (version)
    for (const [name, identity] of identities) {
      const problem = identityProblem(name, identity, { revision, version });
      if (problem) problems.push(problem);
    }
  if (problems.length > 0) throw new Error(problems.join("\n"));

  const sums = files.map((file) => `${sha256(join(dir, file))}  ${file}`).join("\n") + "\n";
  const notes = [
    `Built and tested from ${revision}.`,
    "",
    "| Artifact | Version | Revision | Source inputs |",
    "| --- | --- | --- | --- |",
    ...identities.map(
      ([name, identity]) =>
        `| ${name} | ${identity.version} | \`${identity.revision.slice(0, 12)}\` | \`${identity.inputs}\` |`,
    ),
    "",
    "Diagnostics in the app, and `/api/server-info` on a server, report the same revision.",
    "",
    signed
      ? "The Windows installer is code-signed."
      : "The Windows installer is not code-signed, so Windows SmartScreen may warn before it runs; check its SHA-256 against `SHA256SUMS` first.",
    "",
    "SHA-256:",
    "",
    "```",
    sums.trimEnd(),
    "```",
    "",
  ].join("\n");
  return { sums, notes, files };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, ...rest] = process.argv.slice(2);
  const option = (name) => {
    const at = rest.indexOf(`--${name}`);
    return at === -1 ? undefined : rest[at + 1];
  };
  const revision = option("revision");
  const tag = option("tag");
  const notesPath = option("notes");
  if (!dir || !revision || !tag || !notesPath) {
    console.error(
      "usage: release-manifest.mjs <dir> --revision <sha> --tag <tag> --notes <file> [--signed]",
    );
    process.exit(2);
  }
  try {
    const { sums, notes } = prepareRelease({
      dir: resolve(dir),
      revision,
      tag,
      signed: rest.includes("--signed"),
    });
    writeFileSync(join(resolve(dir), SUMS), sums);
    writeFileSync(resolve(notesPath), notes);
    process.stdout.write(sums);
  } catch (error) {
    console.error(`Not releasing:\n${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
