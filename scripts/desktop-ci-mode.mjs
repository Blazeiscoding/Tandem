import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Runtime checks launch win-unpacked. Validate the installer as well whenever
// its configuration, resources, dependencies, or this selection policy change.
export function needsInstaller(paths) {
  return paths.some(
    (path) =>
      path.endsWith("/package.json") ||
      [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        ".npmrc",
        ".pnpmfile.cjs",
        "apps/desktop/electron-builder.yml",
        "scripts/generate-icons.mjs",
        "scripts/desktop-ci-mode.mjs",
        "scripts/desktop-ci-mode.test.mjs",
        ".github/workflows/desktop.yml",
      ].includes(path) ||
      path.startsWith("apps/desktop/build/"),
  );
}

export function selectDesktopMode({ eventName, installer, baseSha, cwd = process.cwd() }) {
  if (eventName === "workflow_dispatch") {
    return { installer: installer !== "false", reason: "Manual selection" };
  }
  if (eventName !== "pull_request" || !/^[a-f0-9]{40,64}$/i.test(baseSha ?? "")) {
    return { installer: true, reason: "No usable pull request base" };
  }
  const diff = spawnSync("git", ["diff", "--name-only", "-z", baseSha, "HEAD", "--"], {
    cwd,
    encoding: "utf8",
  });
  if (diff.status !== 0) {
    return { installer: true, reason: "Base diff unavailable; retaining installer coverage" };
  }
  const full = needsInstaller(diff.stdout.split("\0").filter(Boolean));
  return {
    installer: full,
    reason: full ? "Installer inputs changed" : "Runtime inputs only; testing unpacked app",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = selectDesktopMode({
    eventName: process.env.CI_EVENT_NAME,
    installer: process.env.CI_BUILD_INSTALLER,
    baseSha: process.env.CI_BASE_SHA,
  });
  console.log(`${mode.reason}: installer=${mode.installer}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `installer=${mode.installer}\n`);
  }
}
