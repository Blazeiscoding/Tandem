import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { identityProblem, prepareRelease, sha256, tagVersion } from "./release-manifest.mjs";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const SCRIPT = fileURLToPath(new URL("./release-manifest.mjs", import.meta.url));

const identity = (over = {}) => ({
  version: "0.2.0",
  revision: REVISION,
  dirty: false,
  inputs: "0a1344b673e188e8",
  builtAt: "2026-10-02T00:00:00.000Z",
  ...over,
});

/** A release directory: identities for the server and desktop app, and two files to publish. */
function release(identities = { server: identity(), desktop: identity() }) {
  const dir = mkdtempSync(join(tmpdir(), "release-manifest-"));
  for (const [name, value] of Object.entries(identities))
    writeFileSync(join(dir, `${name}.build.json`), JSON.stringify(value));
  writeFileSync(join(dir, "Gatherline Setup 0.2.0.exe"), "installer bytes");
  writeFileSync(join(dir, "gatherline-server-0.2.0.tar.gz"), "server bytes");
  return dir;
}

test("a tag names a version, with or without a pre-release", () => {
  assert.equal(tagVersion("v0.2.0"), "0.2.0");
  assert.equal(tagVersion("v0.2.0-rc.1"), "0.2.0");
  assert.equal(tagVersion("0.2.0"), null);
  assert.equal(tagVersion("v0.2"), null);
  assert.equal(tagVersion("release"), null);
});

test("every published file is hashed, and the notes name the tested revision", () => {
  const dir = release();
  try {
    const { sums, notes, files } = prepareRelease({ dir, revision: REVISION, tag: "v0.2.0" });
    assert.deepEqual(files, ["Gatherline Setup 0.2.0.exe", "gatherline-server-0.2.0.tar.gz"]);
    assert.equal(
      sums,
      `${sha256(join(dir, files[0]))}  ${files[0]}\n${sha256(join(dir, files[1]))}  ${files[1]}\n`,
    );
    assert.match(notes, new RegExp(`Built and tested from ${REVISION}`));
    assert.match(notes, /\| desktop \| 0\.2\.0 \| `0123456789ab` \|/);
    assert.match(notes, /\| server \| 0\.2\.0 \| `0123456789ab` \|/);
    // Signing status is stated as it is.
    assert.match(notes, /not code-signed/);
    assert.match(
      prepareRelease({ dir, revision: REVISION, tag: "v0.2.0", signed: true }).notes,
      /is code-signed/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses an artifact built from another commit, changed source, or another version", () => {
  const version = "0.2.0";
  assert.equal(identityProblem("server", identity(), { revision: REVISION, version }), null);
  assert.match(
    identityProblem("server", identity({ revision: OTHER }), { revision: REVISION, version }),
    /server was built from fedcba987654, not 0123456789ab/,
  );
  assert.match(
    identityProblem("desktop", identity({ dirty: true }), { revision: REVISION, version }),
    /uncommitted changes/,
  );
  assert.match(
    identityProblem("desktop", identity({ dirty: null }), { revision: REVISION, version }),
    /could not say/,
  );
  assert.match(
    identityProblem("web", identity({ version: "0.1.0" }), { revision: REVISION, version }),
    /version 0\.1\.0, but the tag names 0\.2\.0/,
  );

  const dir = release({ server: identity(), desktop: identity({ revision: OTHER }) });
  try {
    assert.throws(
      () => prepareRelease({ dir, revision: REVISION, tag: "v0.2.0" }),
      /desktop was built from fedcba987654/,
    );
    assert.throws(
      () => prepareRelease({ dir, revision: REVISION, tag: "latest" }),
      /names no version/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a release with no identities or nothing to publish", () => {
  const empty = mkdtempSync(join(tmpdir(), "release-manifest-"));
  try {
    assert.throws(
      () => prepareRelease({ dir: empty, revision: REVISION, tag: "v0.2.0" }),
      /no artifact identity[\s\S]*nothing to publish/,
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the command writes SHA256SUMS beside the files and the notes where asked", () => {
  const dir = release();
  const notes = join(dir, "..", `notes-${Date.now()}.md`);
  try {
    const run = spawnSync(
      process.execPath,
      [SCRIPT, dir, "--revision", REVISION, "--tag", "v0.2.0", "--notes", notes],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(join(dir, "SHA256SUMS"), "utf8"), run.stdout);
    assert.match(readFileSync(notes, "utf8"), /Built and tested from/);
    // A second run leaves the checksum file out of its own sums.
    const again = spawnSync(
      process.execPath,
      [SCRIPT, dir, "--revision", REVISION, "--tag", "v0.2.0", "--notes", notes],
      { encoding: "utf8" },
    );
    assert.equal(again.stdout, run.stdout);

    const refused = spawnSync(
      process.execPath,
      [SCRIPT, dir, "--revision", OTHER, "--tag", "v0.2.0", "--notes", notes],
      { encoding: "utf8" },
    );
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Not releasing:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(notes, { force: true });
  }
});
