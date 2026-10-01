import { useEffect, useState } from "react";
import type { ServerInfo, WorkspaceStatus } from "@slackoss/protocol";
import { ApiError } from "@slackoss/client-core";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import { diagnosticsReport } from "../lib/diagnostics.js";
import { useCopy } from "../lib/useCopy.js";
import { Dialog } from "./Dialog.js";
import { buttonClass } from "./Button.js";

type Failed = { error: string };
const failure = (err: unknown): Failed => ({
  error: err instanceof Error ? err.message : "no answer",
});

/** Why the server's status could not be read, in words for the report. */
function statusFailure(err: unknown): Failed {
  if (err instanceof ApiError && err.status === 404)
    return { error: "this server's version does not report it" };
  if (err instanceof ApiError && err.status === 403)
    return { error: "only the owner and admins can read it" };
  return failure(err);
}

/**
 * What to send whoever helps when something is wrong. It shows the whole
 * report before anything is copied, and the report holds versions, the
 * connection and the device, never what anybody wrote. For the owner and
 * admins it also says how the server is keeping up (OPS-10): sizes, queues
 * and timings, never what is in them.
 */
export function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const platform = usePlatform();
  const admin = useWorkspace((s) => s.self?.role === "owner" || s.self?.role === "admin");
  const [report, setReport] = useState<string | null>(null);
  const { copy, label } = useCopy(2500);

  // One snapshot, taken when the server answers or fails to: what is shown is
  // exactly what is copied, however long the dialog stays open.
  useEffect(() => {
    let alive = true;
    const take = (server: ServerInfo | Failed, workspace?: WorkspaceStatus | Failed) => {
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
          workspace,
          now: new Date(),
        }),
      );
    };
    void Promise.all([
      client.api.serverInfo().catch(failure),
      admin ? client.api.workspaceStatus().catch(statusFailure) : undefined,
    ]).then(([server, workspace]) => alive && take(server, workspace));
    return () => {
      alive = false;
    };
  }, [client, platform, admin]);

  return (
    <Dialog title="Diagnostics" onClose={onClose} width={560}>
      <p className="text-sm text-ink-dim">
        Send this to whoever is helping you. It says which versions are running and how this device
        is connected
        {admin ? ", and how the server is keeping up: sizes, queues and timings" : ""}. It never
        includes messages, names or files.
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
          {admin ? "Asking the server how it is doing…" : "Asking the server for its version…"}
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <button
          className={buttonClass("primary")}
          disabled={!report}
          onClick={() => report && void copy(report)}
        >
          {label("Copy diagnostics", "Copied", "Could not copy. Select the text instead")}
        </button>
      </div>
    </Dialog>
  );
}
