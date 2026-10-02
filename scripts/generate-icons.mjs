// Optional maintainer command: pnpm exec playwright install chromium, then
// node scripts/generate-icons.mjs. Generated assets are checked in so packaging
// itself never needs a browser download or an image processing dependency.
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = new URL("apps/web/public/tandem.svg", root);
const destination = new URL("apps/desktop/build/", root);
await mkdir(destination, { recursive: true });
await mkdir(new URL("apps/desktop/src/renderer/public/", root), { recursive: true });
await copyFile(source, new URL("apps/desktop/src/renderer/public/tandem.svg", root));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 256, height: 256 },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<style>body{margin:0}svg{width:256px;height:256px;display:block}</style>${await readFile(source, "utf8")}`,
  );
  const png = await page.screenshot({ omitBackground: true });
  await writeFile(new URL("icon.png", destination), png);
  // ICO directory with a single 256px PNG image (width/height zero means 256).
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  await writeFile(new URL("icon.ico", destination), Buffer.concat([header, png]));
} finally {
  await browser.close();
}
