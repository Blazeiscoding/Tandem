import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "helpers",
          environment: "node",
          exclude: [...defaultExclude, "**/*.dom.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "components",
          include: ["test/**/*.dom.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["./test/setup.ts"],
        },
      },
    ],
  },
});
