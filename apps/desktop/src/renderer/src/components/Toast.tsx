import { CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { toast } from "../lib/toast";

/**
 * Where a result message ("Đã lưu") floats: a small glass pill at the bottom, one at a time, gone after ~3 s unless the
 * pointer or keyboard focus is on it. The live region is always in the page (a region that appears together with its
 * text is not announced reliably); only the pill comes and goes. Motion is the shared `animate-pop`, still under reduced motion.
 */
export function ToastHost() {
  const current = useStore(toast.store, (s) => s.current);
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-10 flex justify-center px-4">
      {current && (
        <div
          key={current.id}
          data-toast={current.tone}
          onMouseEnter={toast.pause}
          onMouseLeave={toast.resume}
          onFocus={toast.pause}
          onBlur={toast.resume}
          className="pointer-events-auto glass flex max-w-[min(480px,100%)] animate-pop items-center gap-3 rounded-glass py-1.5 pr-1.5 pl-4 text-ui text-ink"
        >
          {current.tone === "ok" ? <CheckCircle aria-hidden="true" weight="fill" className="shrink-0 text-moss-300" /> : <WarningCircle aria-hidden="true" weight="fill" className="shrink-0 text-danger" />}
          <span className="min-w-0 py-1.5">{current.text}</span>
          <button type="button" onClick={toast.dismiss} aria-label={t("common.close")} className="grid size-10 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-white/8 hover:text-ink active:scale-[.98]">
            <X aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
