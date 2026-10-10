import { useEffect, useRef } from "react";
import { t } from "../i18n/t";
import type { Participant } from "../lib/voice-presence";
import { Avatar } from "./Avatar";

function Video({ source }: { source: NonNullable<Participant["video"]> }) {
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

/** One person in the voice room grid: their camera or an avatar, name below, a ring while they speak. */
export function ParticipantTile({ p }: { p: Participant }) {
  return (
    <li
      data-speaking={p.speaking ? "true" : undefined}
      data-user={p.userId}
      className={`relative aspect-video min-w-0 overflow-hidden rounded-panel bg-surface-3 ring-2 transition-shadow duration-(--duration-fast) ${p.speaking ? "ring-moss-300" : "ring-transparent"}`}
    >
      {p.video ? (
        <Video source={p.video} />
      ) : (
        <div aria-hidden="true" className="grid h-full place-items-center">
          <Avatar id={p.userId} name={p.username} className="size-16 rounded-full text-xl" />
        </div>
      )}
      <span title={p.username} className="absolute bottom-2 left-2 max-w-[calc(100%-16px)] truncate rounded-control bg-surface-0 px-2.5 py-1 text-xs font-medium text-ink">
        {p.username}
        {p.isLocal && ` ${t("voice.you")}`}
      </span>
      {p.speaking && <span className="sr-only">{t("voice.speaking")}</span>}
    </li>
  );
}
