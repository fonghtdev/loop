import { ImageBroken } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { t } from "../i18n/t";
import { gifBox } from "../lib/gifs";
import { openViewer } from "../lib/viewer";

/**
 * A message that is only a GIF link, drawn as the picture. The box is sized from the URL's size hint (or a default)
 * before the file loads, so nothing shifts; clicking opens the image viewer. A failed load shows a quiet note in the same box.
 */
export function GifImage({ url }: { url: string }) {
  const [phase, setPhase] = useState<"loading" | "loaded" | "failed">("loading");
  const opener = useRef<HTMLButtonElement>(null);
  const box = gifBox(url);
  const src = url.split("#")[0]!;
  return (
    <div style={box} className={`max-w-full overflow-hidden rounded-card bg-surface-3 shadow-e2 ${phase === "loading" ? "skeleton" : ""}`}>
      {phase === "failed" ? (
        <p className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center text-sm text-ink-muted">
          <ImageBroken aria-hidden="true" size={28} />
          {t("gif.failed")}
        </p>
      ) : (
        <button ref={opener} type="button" aria-label={t("gif.open")} onClick={() => openViewer(src, t("gif.alt"), opener.current)} className="block size-full">
          <img src={src} alt={t("gif.alt")} loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={() => setPhase("loaded")} onError={() => setPhase("failed")} className="size-full object-contain" />
        </button>
      )}
    </div>
  );
}
