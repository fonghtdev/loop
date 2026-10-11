import { MagnifyingGlassMinus, MagnifyingGlassPlus, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { t } from "../i18n/t";
import { move, spring } from "../lib/motion";
import { useViewer } from "../lib/viewer";
import { CLOSED, flipDelta, viewerStep, ZOOM } from "../lib/viewer-machine";
import { Tooltip } from "./Tooltip";

const HEAD = 150; // the header and padding around the picture, subtracted from the window height

/**
 * The in-app image viewer: a native modal <dialog> (focus trap, Esc, backdrop) on the glass panel. The picture springs
 * out of its thumbnail (FLIP: one transform, nothing else compensated) and back on close; reduced motion jumps. The
 * zoom button / a click on the picture toggles fit <-> 1.8x and the browser's scroll pans (lib/viewer-machine).
 * Esc, the backdrop and the close button all go through `requestClose`; focus returns to the thumbnail. The native
 * autofocus attribute (not React's autoFocus) is what showModal() honours, and it must stay on Close, not on the zoom button.
 */
export function ImageViewer() {
  const viewing = useViewer((s) => s.viewing);
  const [state, dispatch] = useReducer(viewerStep, CLOSED);
  const [broken, setBroken] = useState(false);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const pan = useRef<HTMLDivElement>(null);
  const thumb = useRef<DOMRect | null>(null);
  const flown = useRef(false);

  const flipRect = () => {
    const o = useViewer.getState().viewing?.opener;
    return o?.isConnected ? (o.querySelector("img") ?? o).getBoundingClientRect() : null;
  };

  // open: the dialog first (so the picture has its final place), then the picture flies out of the thumbnail
  useEffect(() => {
    const d = dialog.current;
    setBroken(false);
    setFit(null);
    flown.current = false;
    if (!viewing || !d) return;
    thumb.current = flipRect();
    if (!d.open) d.showModal();
    dispatch("open");
    if (img.current?.complete && img.current.naturalWidth > 0) flyIn();
  }, [viewing]); // eslint-disable-line react-hooks/exhaustive-deps

  function flyIn() {
    const el = img.current;
    if (!el || flown.current) return;
    flown.current = true;
    const from = thumb.current;
    if (!from) return dispatch("opened");
    const { x, y, scale } = flipDelta(from, el.getBoundingClientRect());
    move(el, { x: [x, 0], y: [y, 0], scale: [scale, 1], ease: spring({ bounce: 0.2, duration: 260 }), duration: 260, onComplete: () => (clearMotion(el), dispatch("opened")) });
  }

  const clearMotion = (el: HTMLElement) => {
    el.style.removeProperty("transform");
    el.style.removeProperty("opacity");
  };

  function requestClose() {
    const el = img.current;
    const to = flipRect();
    const finish = () => (dispatch("closed"), dialog.current?.close());
    if (state.phase === "closing") return;
    dispatch("close");
    if (!el || !to || (state.phase === "open" && state.zoom === "zoom") || broken) return finish();
    const { x, y, scale } = flipDelta(to, el.getBoundingClientRect());
    move(el, { x: [0, x], y: [0, y], scale: [1, scale], opacity: [1, 0.4], ease: "inQuad", duration: 180, onComplete: finish });
  }

  const onClose = () => {
    const opener = useViewer.getState().viewing?.opener;
    useViewer.setState({ viewing: null });
    opener?.focus();
  };

  const zoomed = state.phase === "open" && state.zoom === "zoom";
  const toggleZoom = () => {
    if (state.phase !== "open") return;
    if (state.zoom === "fit" && img.current) {
      const r = img.current.getBoundingClientRect();
      setFit({ w: r.width, h: r.height });
    }
    dispatch("toggleZoom");
  };
  useLayoutEffect(() => {
    const p = pan.current;
    if (zoomed && p) {
      p.scrollLeft = (p.scrollWidth - p.clientWidth) / 2;
      p.scrollTop = (p.scrollHeight - p.clientHeight) / 2;
    }
  }, [zoomed]);

  const zoomLabel = zoomed ? t("viewer.zoomOut") : t("viewer.zoomIn");
  return (
    <dialog
      ref={dialog}
      data-viewer
      data-phase={state.phase}
      data-zoom={state.phase === "open" ? state.zoom : undefined}
      aria-label={viewing?.filename ?? t("viewer.title")}
      onCancel={(e) => (e.preventDefault(), requestClose())}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && requestClose()} // a click on the backdrop lands on the dialog itself
      className="m-auto glass rounded-panel p-0 text-ink"
    >
      {viewing && (
        <div className="flex max-w-[calc(100vw-48px)] flex-col gap-3 p-4">
          <div className="flex items-center gap-2">
            <Tooltip label={viewing.filename}>
              <p className="min-w-0 flex-1 truncate text-ui font-semibold select-text">{viewing.filename}</p>
            </Tooltip>
            {!broken && (
              <Tooltip label={zoomLabel}>
                <button type="button" onClick={toggleZoom} aria-label={zoomLabel} className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink active:scale-[.98]">
                  {zoomed ? <MagnifyingGlassMinus aria-hidden="true" /> : <MagnifyingGlassPlus aria-hidden="true" />}
                </button>
              </Tooltip>
            )}
            <Tooltip label={t("common.close")} kbd="Esc">
              <button type="button" ref={(el) => el?.setAttribute("autofocus", "")} onClick={requestClose} aria-label={t("common.close")} className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink active:scale-[.98]">
                <X aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
          {broken ? (
            <p className="flex items-center gap-2 py-10 text-ui text-ink-muted">
              <WarningCircle aria-hidden="true" className="text-danger" />
              {t("attachment.imageFailed")}
            </p>
          ) : (
            <div ref={pan} style={zoomed && fit ? { width: fit.w, height: fit.h } : undefined} className={`rounded-control ${zoomed ? "overflow-auto" : "overflow-hidden"}`}>
              <img
                ref={img}
                src={viewing.src}
                alt={viewing.filename}
                referrerPolicy="no-referrer"
                onLoad={flyIn}
                onError={() => (setBroken(true), dispatch("opened"))}
                onClick={toggleZoom}
                style={zoomed && fit ? { width: fit.w * ZOOM, height: fit.h * ZOOM, maxWidth: "none", maxHeight: "none" } : { maxHeight: `calc(100vh - ${HEAD}px)` }}
                className={`block max-w-full object-contain ${zoomed ? "cursor-zoom-out" : "cursor-zoom-in"}`}
              />
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
