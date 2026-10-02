import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { precompress } from "./precompress";

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
});
