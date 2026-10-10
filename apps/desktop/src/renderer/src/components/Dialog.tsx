import { useEffect, useId, useRef, type ReactNode } from "react";
import { Banner } from "./Banner";

/**
 * A modal on the native <dialog>: showModal() gives the focus trap, Esc, the backdrop and inert background, and
 * focus returns to the opener on close. Content mounts only while open, so forms start fresh every time.
 */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      // a click on the backdrop lands on the dialog element itself
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="m-auto w-[min(440px,calc(100vw-48px))] animate-rise rounded-panel bg-surface-2 p-0 text-ink shadow-raised"
    >
      {open && (
        <div className="flex flex-col gap-4 p-6">
          <h2 id={titleId} className="font-display text-xl font-bold tracking-tight break-words">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** The button row at the bottom of a dialog. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-2 flex justify-end gap-2">{children}</div>;
}

/** A failed submit, announced when it appears. */
export function DialogError({ message }: { message: string }) {
  return (
    <div aria-live="assertive" className="empty:hidden">
      {message && <Banner tone="danger">{message}</Banner>}
    </div>
  );
}
