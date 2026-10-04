import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const requireUi = createRequire(`${root}/packages/ui/package.json`);
const requireServer = createRequire(`${root}/packages/server/package.json`);
export default {
  root,
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      vitest: `${dirname(requireUi.resolve("vitest/package.json"))}/dist/index.js`,
      react: dirname(requireUi.resolve("react/package.json")),
      "react-dom": dirname(requireUi.resolve("react-dom/package.json")),
      "@testing-library/react": requireUi.resolve("@testing-library/react"),
      "@testing-library/user-event": requireUi.resolve("@testing-library/user-event"),
      "@slackoss/client-core": `${root}/packages/client-core/src/index.ts`,
      "@slackoss/protocol/rest": `${root}/packages/protocol/src/rest.ts`,
      "@slackoss/protocol": `${root}/packages/protocol/src/index.ts`,
      "@slackoss/server": `${root}/packages/server/src/index.ts`,
      ws: requireServer.resolve("ws"),
    },
  },
  test: {
    include: ["docs/research/2026-10-04-next/client/client-ui.dom.test.tsx"],
    environment: "jsdom",
    setupFiles: ["packages/ui/test/setup.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15_000,
  },
};
