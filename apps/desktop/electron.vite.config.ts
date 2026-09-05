import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    plugins: [
      // Workspace packages are TS source — bundle them; real deps stay external.
      externalizeDepsPlugin({ exclude: ["@slackoss/server", "@slackoss/protocol"] }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } } },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: { minify: true, cssMinify: true },
  },
});
