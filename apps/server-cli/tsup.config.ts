import { defineConfig } from "tsup";

/** Bundle the whole server (deps included) into one runnable file — zero-install deploys. */
export default defineConfig({
  entry: { "slackoss-server": "../../packages/server/src/main.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  noExternal: [/.*/],
  external: [/^node:/],
  banner: {
    js: [
      "#!/usr/bin/env node",
      // CJS deps bundled into ESM need a real require for node builtins.
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  clean: true,
});
