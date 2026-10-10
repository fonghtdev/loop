import { WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/t";
import { useViewer } from "../lib/viewer";

/**
 * The in-app image viewer: a native modal <dialog> (focus trap, Esc, backdrop) on the glass panel, the image
 * fitted to the window. Closing returns focus to the thumbnail that opened it.
 * ponytail: no pan or zoom; fit-to-window covers viewing, add them when people ask to inspect detail.
 */
export function ImageViewer() {
  const viewing = useViewer((s) => s.viewing);
  const ref = useRef<HTMLDialogElement>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    const d = ref.current;
    setBroken(false);
    if (viewing && !d?.open) d?.showModal();
    if (!viewing && d?.open) d.close();
  }, [viewing]);

  const close = () => {
    const opener = useViewer.getState().viewing?.opener;
    useViewer.setState({ viewing: null });
    opener?.focus();
  };

  return (
    <dialog
      ref={ref}
      aria-label={viewing?.filename ?? t("viewer.title")}
      onClose={close}
      onClick={(e) => e.target === e.currentTarget && close()} // a click on the backdrop lands on the dialog itself
      className="m-auto animate-rise glass rounded-panel p-0 text-ink"
    >
      {viewing && (
        <div className="flex max-w-[calc(100vw-48px)] flex-col gap-3 p-4">
          <div className="flex items-center gap-3">
            <p title={viewing.filename} className="min-w-0 flex-1 truncate text-sm font-semibold select-text">
              {viewing.filename}
            </p>
            <button
              type="button"
              autoFocus
              onClick={close}
              aria-label={t("common.close")}
              title={t("common.close")}
              className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          {broken ? (
            <p className="flex items-center gap-2 py-10 text-sm text-ink-muted">
              <WarningCircle aria-hidden="true" className="text-danger" />
              {t("attachment.imageFailed")}
            </p>
          ) : (
            <img
              src={viewing.src}
              alt={viewing.filename}
              referrerPolicy="no-referrer"
              onError={() => setBroken(true)}
              className="max-h-[calc(100vh-150px)] max-w-full rounded-control object-contain"
            />
          )}
        </div>
      )}
    </dialog>
  );
}
