import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const file = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/PROJECT-VISUALIZER.html");
const port = Number(process.env.VISUALIZER_PORT ?? 4178);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid VISUALIZER_PORT");
const server = createServer(async (request, response) => {
  if (!["/", "/PROJECT-VISUALIZER.html"].includes(request.url?.split("?")[0])) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const html = await readFile(file);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : html);
  } catch {
    response.writeHead(503).end("Run pnpm visualizer:build first.");
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Project visualizer: http://127.0.0.1:${port}`));
