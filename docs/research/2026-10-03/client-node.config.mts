import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const requireClient = createRequire(`${root}/packages/client-core/package.json`);
export default {
  root,
  resolve: {
    alias: {
      vitest: `${dirname(requireClient.resolve("vitest/package.json"))}/dist/index.js`,
      "@slackoss/client-core": `${root}/packages/client-core/src/index.ts`,
      "@slackoss/protocol": `${root}/packages/protocol/src/index.ts`,
      "@slackoss/server": `${root}/packages/server/src/index.ts`,
    },
  },
  test: {
    include: [
      "docs/research/2026-10-03/client-state.test.ts",
      "docs/research/2026-10-03/client-files.test.ts",
    ],
    environment: "node",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15_000,
  },
};
