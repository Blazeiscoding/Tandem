import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const requireUi = createRequire(`${root}/packages/ui/package.json`);

export default {
  root,
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      vitest: `${dirname(requireUi.resolve("vitest/package.json"))}/dist/index.js`,
      react: dirname(requireUi.resolve("react/package.json")),
      "react-dom": dirname(requireUi.resolve("react-dom/package.json")),
      "@testing-library/react": requireUi.resolve("@testing-library/react"),
      "@slackoss/client-core": `${root}/packages/client-core/src/index.ts`,
      "@slackoss/protocol/rest": `${root}/packages/protocol/src/rest.ts`,
      "@slackoss/protocol": `${root}/packages/protocol/src/index.ts`,
    },
  },
  test: {
    include: ["docs/research/2026-10-02-post-implementation/client-ui.dom.test.tsx"],
    environment: "jsdom",
    setupFiles: ["packages/ui/test/setup.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15_000,
  },
};
