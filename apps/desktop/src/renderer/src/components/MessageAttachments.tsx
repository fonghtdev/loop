import { ArrowClockwise, File, FileArchive, FileAudio, FilePdf, FileText, FileVideo, ImageBroken } from "@phosphor-icons/react";
import { INLINE_TYPES } from "@loop/shared";
import { useEffect, useReducer, useRef, type ReactNode } from "react";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";
import { session } from "../lib/app";
import { fileKind, formatSize, type FileKind } from "../lib/attachment-rules";
import { imageStep, initialImage } from "../lib/image-state";
import { openViewer } from "../lib/viewer";
import { Tooltip } from "./Tooltip";

/** What a message shows for one file: the server's attachment, or the optimistic one (a local blob preview). */
export type Shown = { id: string; filename: string; contentType: string; size: number; url: string | null };

const ICONS: Record<FileKind, ReactNode> = {
  image: <File aria-hidden="true" />,
  pdf: <FilePdf aria-hidden="true" />,
  zip: <FileArchive aria-hidden="true" />,
  text: <FileText aria-hidden="true" />,
  video: <FileVideo aria-hidden="true" />,
  audio: <FileAudio aria-hidden="true" />,
};
const KIND_LABELS: Record<FileKind, MessageKey> = {
  image: "attachment.kind.image",
  pdf: "attachment.kind.pdf",
  zip: "attachment.kind.zip",
  text: "attachment.kind.text",
  video: "attachment.kind.video",
  audio: "attachment.kind.audio",
};

/** The icon and label of a file type, shared by the message card and the composer tray. */
export const FileGlyph = ({ contentType }: { contentType: string }) => ICONS[fileKind(contentType)];
export const kindLabel = (contentType: string) => t(KIND_LABELS[fileKind(contentType)]);

/** Files under a message: images inline (click opens the viewer), everything else as a card. */
export function MessageAttachments({ attachments, preview = false }: { attachments: Shown[]; preview?: boolean }) {
  if (!attachments.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-start gap-2">
      {attachments.map((a) =>
        INLINE_TYPES.includes(a.contentType) ? <InlineImage key={a.id} attachment={a} preview={preview} /> : <FileCard key={a.id} attachment={a} preview={preview} />,
      )}
    </div>
  );
}

/**
 * The box is the same size whatever the picture (object-contain inside it), so loading never moves the text
 * around it: no layout shift, no scroll jump. The server gives no dimensions to reserve anything smarter.
 */
function InlineImage({ attachment: a, preview }: { attachment: Shown; preview: boolean }) {
  const [img, dispatch] = useReducer(imageStep, initialImage(a.url ?? ""));
  const opener = useRef<HTMLButtonElement>(null);

  // One failed load -> one fresh URL (GET /attachments/:id). The reducer allows that refresh once; no loops.
  useEffect(() => {
    if (img.phase !== "refreshing") return;
    let alive = true;
    session.client
      .request<{ url: string }>("GET", `/attachments/${a.id}`)
      .then((r) => alive && dispatch({ type: "fresh", url: r.url }))
      .catch(() => alive && dispatch({ type: "freshFailed" }));
    return () => {
      alive = false;
    };
  }, [img.phase, a.id]);

  return (
    <figure className="m-0 w-80 max-w-full">
      <div className={`relative h-60 overflow-hidden rounded-card bg-surface-3 shadow-e2 ${img.phase === "loading" || img.phase === "refreshing" ? "skeleton" : ""}`}>
        {img.phase === "failed" ? (
          <div className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center text-sm text-ink-muted">
            <ImageBroken aria-hidden="true" size={28} />
            <p>{t("attachment.imageFailed")}</p>
            {!preview && (
              <button type="button" onClick={() => dispatch({ type: "retry" })} className="inline-flex h-10 items-center gap-2 rounded-control px-3 font-medium text-moss-300 hover:bg-surface-4">
                <ArrowClockwise aria-hidden="true" />
                {t("common.retry")}
              </button>
            )}
          </div>
        ) : (
          <button
            ref={opener}
            type="button"
            aria-label={t("attachment.openImage", { name: a.filename })}
            onClick={() => openViewer(img.src, a.filename, opener.current)}
            disabled={img.phase === "refreshing"}
            className="block size-full"
          >
            {img.phase !== "refreshing" && (
              <img
                src={img.src}
                alt={a.filename}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                onLoad={() => dispatch({ type: "loaded" })}
                onError={() => dispatch({ type: "error" })}
                className="size-full object-contain"
              />
            )}
          </button>
        )}
      </div>
      <figcaption title={a.filename} className="mt-1 truncate text-caption text-ink-faint select-text">
        {a.filename}
      </figcaption>
    </figure>
  );
}

/** Opening a file asks for a fresh URL first (the one in the message may have expired), then the OS browser downloads it. */
async function openFile(a: Shown) {
  const fresh = await session.client.request<{ url: string }>("GET", `/attachments/${a.id}`).catch(() => null);
  const url = fresh?.url ?? a.url;
  if (url) void window.loop.openExternal(url);
}

function FileCard({ attachment: a, preview }: { attachment: Shown; preview: boolean }) {
  const body = (
    <>
      <span className="grid size-10 shrink-0 place-items-center rounded-control bg-moss-900 text-moss-300 shadow-[inset_0_1px_0_rgb(255_255_255/.08)]">
        <FileGlyph contentType={a.contentType} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-semibold text-ink">{a.filename}</span>
        <span className="numeric block truncate text-caption text-ink-muted">
          {kindLabel(a.contentType)}, {formatSize(a.size)}
        </span>
      </span>
    </>
  );
  const cls = "relative edge flex h-16 w-72 max-w-full items-center gap-3 rounded-card bg-raise px-3 text-left shadow-e1";
  return preview ? (
    <div className={`${cls} opacity-70`}>
      {body}
    </div>
  ) : (
    <Tooltip label={a.filename}>
      <button type="button" aria-label={t("attachment.download", { name: a.filename })} onClick={() => void openFile(a)} className={`${cls} transition-[background-color,scale] duration-(--duration-fast) hover:bg-surface-4 active:scale-[.98]`}>
        {body}
      </button>
    </Tooltip>
  );
}
