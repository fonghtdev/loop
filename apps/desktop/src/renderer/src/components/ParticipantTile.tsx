import { useEffect, useRef, type CSSProperties } from "react";
import { t } from "../i18n/t";
import { move, spring } from "../lib/motion";
import type { Tile } from "../lib/voice-grid";
import { Avatar } from "./Avatar";
import { Tooltip } from "./Tooltip";

function Video({ source }: { source: NonNullable<Tile["p"]["video"]> }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    source.attach(el);
    return () => void source.detach(el);
  }, [source]);
  // sound comes from the <audio> elements; this element only shows the picture
  return <video ref={ref} autoPlay playsInline muted className="h-full w-full object-cover" />;
}

/**
 * One person in the voice room grid: their camera or an avatar, name chip, and a cosmic ring while they speak (on/off:
 * there is no per-person audio level; the ring is driven by --lv so a level could drive it later). A tile that joins
 * springs in, one that leaves springs out (opacity + transform; instant under reduced motion) and then asks to be dropped.
 */
export function ParticipantTile({ tile, onGone }: { tile: Tile; onGone: (userId: string) => void }) {
  const { p, state } = tile;
  const el = useRef<HTMLLIElement>(null);
  const entered = useRef(state === "enter");

  useEffect(() => {
    const li = el.current;
    if (!li) return;
    const clear = () => {
      li.style.removeProperty("opacity");
      li.style.removeProperty("transform");
    };
    if (state === "leave") {
      move(li, { opacity: [1, 0], scale: [1, 0.96], ease: "inQuad", duration: 160, onComplete: () => onGone(p.userId) });
    } else if (entered.current) {
      entered.current = false;
      move(li, { opacity: [0, 1], y: [10, 0], scale: [0.96, 1], ease: spring({ bounce: 0.2, duration: 260 }), duration: 260, onComplete: clear });
    } else clear(); // came back while leaving
  }, [state, p.userId, onGone]);

  return (
    <li
      ref={el}
      data-speaking={p.speaking ? "true" : undefined}
      data-user={p.userId}
      style={{ "--lv": p.speaking ? 1 : 0 } as CSSProperties}
      className="relative edge @container aspect-[16/10] min-w-0 overflow-hidden rounded-panel bg-raise shadow-e2"
    >
      {p.video ? (
        <Video source={p.video} />
      ) : (
        <div aria-hidden="true" className="grid h-full place-items-center pb-[8cqw]">
          <Avatar id={p.userId} name={p.username} speaking={!!p.speaking} className="size-[clamp(36px,26cqw,88px)] rounded-full text-[clamp(13px,9cqw,30px)]" />
        </div>
      )}
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-1 rounded-panel opacity-(--lv) shadow-[inset_0_0_0_2px_var(--color-cosmic-300),inset_0_0_36px_-4px_var(--color-cosmic-glow)] transition-opacity duration-140 ease-(--ease-out-soft)" />
      <Tooltip label={p.username}>
        <span className="absolute bottom-2 left-2 z-1 max-w-[calc(100%-16px)] truncate rounded-control bg-surface-0/80 px-2.5 py-1 text-caption font-medium text-ink">
          {p.username}
          {p.isLocal && ` ${t("voice.you")}`}
        </span>
      </Tooltip>
      {p.speaking && <span className="sr-only">{t("voice.speaking")}</span>}
    </li>
  );
}
