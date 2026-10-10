import { ArrowClockwise, X } from "@phosphor-icons/react";
import { t } from "../i18n/t";
import { failureText, phaseText } from "../lib/attachment-text";
import type { QueueItem } from "../lib/attachment-queue";
import { formatSize } from "../lib/attachment-rules";
import { FileGlyph } from "./MessageAttachments";

/** The files waiting to be sent: a card each with progress, and Retry / Remove. */
export function AttachmentTray({ items, onRetry, onRemove }: { items: QueueItem[]; onRetry: (id: string) => void; onRemove: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <ul aria-label={t("attachment.tray")} className="mb-2 grid max-h-52 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 overflow-y-auto">
      {items.map(({ id, filename, file, previewUrl, state }) => (
        <li key={id} className={`flex min-w-0 items-center gap-2.5 rounded-control border bg-surface-3 py-1.5 pr-1 pl-2 ${state.phase === "failed" ? "border-danger" : "border-line"}`}>
          <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-surface-2 text-moss-300">
            {previewUrl ? <img src={previewUrl} alt="" className="size-full object-cover" /> : <FileGlyph contentType={file.type} />}
          </span>
          <span className="min-w-0 flex-1">
            <span title={filename} className="block truncate text-sm font-medium text-ink">
              {filename}
            </span>
            <span className={`block truncate text-xs ${state.phase === "failed" ? "font-medium text-danger" : "text-ink-muted"}`} title={state.phase === "failed" ? failureText(state.reason) : undefined}>
              {state.phase === "ready" ? formatSize(file.size) : phaseText(state)}
            </span>
            {state.phase === "uploading" && (
              <span role="progressbar" aria-label={filename} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress * 100)} className="mt-1 block h-1 overflow-hidden rounded-full bg-surface-4">
                <span className="block h-full rounded-full bg-moss-400" style={{ width: `${Math.round(state.progress * 100)}%` }} />
              </span>
            )}
          </span>
          {state.phase === "failed" && (
            <button type="button" onClick={() => onRetry(id)} aria-label={t("attachment.retry", { name: filename })} title={t("common.retry")} className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink">
              <ArrowClockwise aria-hidden="true" />
            </button>
          )}
          <button type="button" onClick={() => onRemove(id)} aria-label={t("attachment.remove", { name: filename })} title={t("attachment.removeShort")} className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink">
            <X aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
