import { ArrowClockwise, X } from "@phosphor-icons/react";
import { t } from "../i18n/t";
import { phaseText } from "../lib/attachment-text";
import type { QueueItem } from "../lib/attachment-queue";
import { formatSize } from "../lib/attachment-rules";
import { FileGlyph } from "./MessageAttachments";
import { Tooltip } from "./Tooltip";

/** The files waiting to be sent: a card each with progress, and Retry / Remove. */
export function AttachmentTray({ items, onRetry, onRemove }: { items: QueueItem[]; onRetry: (id: string) => void; onRemove: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <ul aria-label={t("attachment.tray")} className="mb-2 grid max-h-52 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 overflow-y-auto">
      {items.map(({ id, filename, file, previewUrl, state }) => (
        <li key={id} className={`relative edge flex min-w-0 items-center gap-2.5 rounded-card bg-raise py-1.5 pr-1 pl-1.5 shadow-e1 ${state.phase === "failed" ? "ring-1 ring-danger" : ""}`}>
          <span className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-control bg-surface-2 text-moss-300">
            {previewUrl ? <img src={previewUrl} alt="" className="size-full object-cover" /> : <FileGlyph contentType={file.type} />}
            {state.phase === "uploading" && <ProgressRing name={filename} fraction={state.progress} />}
          </span>
          <span className="min-w-0 flex-1">
            <Tooltip label={filename}>
              <span className="block truncate text-ui font-medium text-ink">{filename}</span>
            </Tooltip>
            <span className={`block text-caption ${state.phase === "failed" ? "font-medium text-danger" : "truncate text-ink-muted"}`}>
              {state.phase === "ready" ? formatSize(file.size) : phaseText(state)}
            </span>
          </span>
          {state.phase === "failed" && (
            <Tooltip label={t("common.retry")}>
              <button type="button" onClick={() => onRetry(id)} aria-label={t("attachment.retry", { name: filename })} className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink active:scale-[.98]">
                <ArrowClockwise aria-hidden="true" />
              </button>
            </Tooltip>
          )}
          <Tooltip label={t("attachment.removeShort")}>
            <button type="button" onClick={() => onRemove(id)} aria-label={t("attachment.remove", { name: filename })} className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink active:scale-[.98]">
              <X aria-hidden="true" />
            </button>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

const RING = 2 * Math.PI * 15;

/** The upload progress as a ring over the thumbnail (the loop-style arc; only stroke-dashoffset changes). */
function ProgressRing({ name, fraction }: { name: string; fraction: number }) {
  const pct = Math.round(fraction * 100);
  return (
    <span role="progressbar" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="absolute inset-0 grid place-items-center bg-surface-0/65">
      <svg viewBox="0 0 36 36" aria-hidden="true" className="size-8 -rotate-90">
        <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" className="stroke-surface-5" />
        <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={RING * (1 - fraction)} className="stroke-moss-300 transition-[stroke-dashoffset] duration-(--duration-base)" />
      </svg>
    </span>
  );
}
