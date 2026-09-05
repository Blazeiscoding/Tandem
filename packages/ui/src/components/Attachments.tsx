import { useEffect, useState } from "react";
import type { FileMeta, ID } from "@slackoss/protocol";
import type { LocalAttachment } from "@slackoss/client-core";
import { useClient } from "../context.js";
import { formatBytes } from "../lib/format.js";

/** Largest an inline image is drawn at; the real file opens in the lightbox. */
const MAX_W = 380;
const MAX_H = 300;

function fitted(width: number | null, height: number | null) {
  if (!width || !height) return { width: MAX_W, height: 220 };
  const scale = Math.min(MAX_W / width, MAX_H / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function MessageAttachments({
  files,
  onOpenImage,
}: {
  files: FileMeta[];
  onOpenImage: (file: FileMeta) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {files.map((f) =>
        f.mime.startsWith("image/") ? (
          <ImageAttachment key={f.id} file={f} onOpen={() => onOpenImage(f)} />
        ) : (
          <FileCard key={f.id} file={f} />
        ),
      )}
    </div>
  );
}

function ImageAttachment({ file, onOpen }: { file: FileMeta; onOpen: () => void }) {
  const url = useFileUrl(file.id);
  const box = fitted(file.width, file.height);
  return (
    <button
      onClick={onOpen}
      title={file.name}
      // Size is reserved from the stored dimensions, so nothing jumps on load.
      style={{ width: box.width, height: box.height }}
      className="group/img relative overflow-hidden rounded-xl border border-edge bg-lifted transition-colors hover:border-copper/50"
    >
      {url ? (
        <img
          src={url}
          alt={file.name}
          className="size-full object-cover transition-transform duration-200 group-hover/img:scale-[1.02]"
        />
      ) : (
        <span className="flex size-full items-center justify-center font-mono text-[11px] text-ink-faint">
          loading…
        </span>
      )}
    </button>
  );
}

function FileCard({ file }: { file: FileMeta }) {
  const client = useClient();
  const [saving, setSaving] = useState(false);

  // Sandboxed viewers block <a download>, so fetch the bytes and save via a click we own.
  async function save() {
    setSaving(true);
    try {
      const url = await client.files.get(file.id);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      onClick={save}
      className="flex items-center gap-2.5 rounded-xl border border-edge bg-raised px-3 py-2.5 text-left transition-colors hover:border-copper/50"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-lifted text-base">
        {iconFor(file.mime, file.name)}
      </span>
      <span className="min-w-0">
        <span className="block max-w-[220px] truncate text-sm font-medium">{file.name}</span>
        <span className="block font-mono text-[11px] text-ink-faint">
          {saving ? "saving…" : formatBytes(file.size)}
        </span>
      </span>
    </button>
  );
}

function iconFor(mime: string, name: string): string {
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf") return "📕";
  if (/zip|tar|gzip|compressed/.test(mime)) return "🗜";
  if (/\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|json|yml|yaml|sh)$/i.test(name)) return "📜";
  if (mime.startsWith("text/")) return "📄";
  return "📎";
}

/** Blob URL for an upload, resolved through the client's shared cache. */
export function useFileUrl(fileId: ID): string | null {
  const client = useClient();
  const [url, setUrl] = useState<string | null>(() => client.files.peek(fileId) ?? null);

  useEffect(() => {
    client.files.retain(fileId);
    let active = true;
    setUrl(null);
    client.files
      .get(fileId)
      .then((u) => {
        if (active) setUrl(u);
      })
      .catch(() => {
        /* file removed or unreachable — the placeholder stays */
      });
    return () => {
      active = false;
      client.files.release(fileId);
    };
  }, [client, fileId]);

  return url;
}

/** Attachments on a message that hasn't reached the server yet. */
export function PendingAttachments({
  attachments,
  progress,
}: {
  attachments: LocalAttachment[];
  progress: number | null;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {attachments.map((a, i) => (
        <div
          key={i}
          className="relative overflow-hidden rounded-xl border border-edge bg-lifted"
          style={{ width: a.previewUrl ? 200 : undefined }}
        >
          {a.previewUrl ? (
            <img src={a.previewUrl} alt={a.name} className="block max-h-[160px] w-full object-cover" />
          ) : (
            <div className="px-3 py-2.5">
              <div className="max-w-[200px] truncate text-sm">{a.name}</div>
              <div className="font-mono text-[11px] text-ink-faint">{formatBytes(a.size)}</div>
            </div>
          )}
          {progress !== null && progress < 1 && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-ground/70">
              <div
                className="h-full bg-copper transition-[width] duration-150"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Full-size image viewer. Esc or a click outside closes it. */
export function Lightbox({ file, onClose }: { file: FileMeta; onClose: () => void }) {
  const url = useFileUrl(file.id);
  const client = useClient();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/85 p-8"
    >
      {url && (
        <img
          src={url}
          alt={file.name}
          className="max-h-[80vh] max-w-full rounded-lg object-contain shadow-2xl"
        />
      )}
      <div className="flex items-center gap-3 text-sm text-ink-dim">
        <span className="max-w-[420px] truncate">{file.name}</span>
        <span className="font-mono text-[11px] text-ink-faint">{formatBytes(file.size)}</span>
        <button
          onClick={async () => {
            const u = await client.files.get(file.id);
            const a = document.createElement("a");
            a.href = u;
            a.download = file.name;
            a.click();
          }}
          className="rounded-lg border border-edge px-3 py-1 transition-colors hover:border-copper hover:text-ink"
        >
          Save
        </button>
        <button
          onClick={onClose}
          className="rounded-lg border border-edge px-3 py-1 transition-colors hover:border-copper hover:text-ink"
        >
          Close
        </button>
      </div>
    </div>
  );
}
