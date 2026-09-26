import { useEffect, useState } from "react";
import type { ServerInfo } from "@slackoss/protocol";
import { useClient, usePlatform } from "../context.js";
import { diagnosticsReport } from "../lib/diagnostics.js";
import { useCopy } from "../lib/useCopy.js";
import { Dialog, primaryBtnCls } from "./Dialog.js";

/**
 * What to send whoever helps when something is wrong. It shows the whole
 * report before anything is copied, and the report holds versions, the
 * connection and the device, never what anybody wrote.
 */
export function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const platform = usePlatform();
  const [report, setReport] = useState<string | null>(null);
  const { copy, label } = useCopy(2500);

  // One snapshot, taken when the server answers or fails to: what is shown is
  // exactly what is copied, however long the dialog stays open.
  useEffect(() => {
    let alive = true;
    const take = (server: ServerInfo | { error: string }) => {
      const { status, huddle, pending } = client.state;
      setReport(
        diagnosticsReport({
          app: platform.kind,
          address: client.baseUrl,
          status,
          server,
          huddle,
          waitingToSend: pending.length,
          userAgent: navigator.userAgent,
          online: navigator.onLine,
          width: window.innerWidth,
          height: window.innerHeight,
          pixelRatio: window.devicePixelRatio,
          notifications:
            platform.kind === "desktop"
              ? "shown by the app"
              : typeof Notification === "undefined"
                ? "not supported"
                : Notification.permission,
          now: new Date(),
        }),
      );
    };
    client.api
      .serverInfo()
      .then((info) => alive && take(info))
      .catch((err: unknown) => {
        if (alive) take({ error: err instanceof Error ? err.message : "no answer" });
      });
    return () => {
      alive = false;
    };
  }, [client, platform]);

  return (
    <Dialog title="Diagnostics" onClose={onClose} width={560}>
      <p className="text-sm text-ink-dim">
        Send this to whoever is helping you. It says which versions are running and how this device
        is connected. It never includes messages, names or files.
      </p>
      {report ? (
        <pre
          aria-label="Diagnostics report"
          tabIndex={0}
          className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-edge bg-ground p-3 font-mono text-xs text-ink-dim"
        >
          {report}
        </pre>
      ) : (
        <p role="status" className="mt-3 text-sm text-ink-faint">
          Asking the server for its version…
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <button
          className={primaryBtnCls}
          disabled={!report}
          onClick={() => report && void copy(report)}
        >
          {label("Copy diagnostics", "Copied", "Could not copy. Select the text instead")}
        </button>
      </div>
    </Dialog>
  );
}
