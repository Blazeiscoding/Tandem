import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { OutboundError, postToUrl } from "../src/outbound.js";

describe("outbound request deadline", () => {
  it("stops a response that keeps sending bytes before the idle timeout", async () => {
    let peerClosed = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first");
      let sent = 0;
      const stream = setInterval(() => {
        res.write("next");
        if (++sent === 25) {
          clearInterval(stream);
          res.end();
        }
      }, 20);
      res.on("close", () => {
        peerClosed = true;
        clearInterval(stream);
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected a TCP listener");

      const started = performance.now();
      const result = await postToUrl(
        `http://127.0.0.1:${address.port}/stream`,
        "{}",
        "application/json",
        { allowPrivate: true, timeoutMs: 100 },
      ).catch((error: unknown) => error);
      const elapsed = performance.now() - started;

      expect(result).toBeInstanceOf(OutboundError);
      expect((result as OutboundError).code).toBe("timeout");
      expect(elapsed).toBeLessThan(350);
      await expect.poll(() => peerClosed).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
