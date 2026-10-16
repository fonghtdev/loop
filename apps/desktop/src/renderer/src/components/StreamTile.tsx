import { Monitor } from "@phosphor-icons/react";
import { t } from "../i18n/t";
import { useDisplayName } from "../lib/identity-hooks";
import type { Participant } from "../lib/voice-presence";
import { LiveBadge } from "./LiveBadge";
import { Video } from "./ParticipantTile";
import { Tooltip } from "./Tooltip";

/**
 * A small tile in the strip under the stage for one stream that is not on stage: a thumbnail while it is watched (or our
 * own), a monitor otherwise, the red live badge, and the owner's name. Pressing it puts that stream on the stage.
 */
export function StreamTile({ p, watched, className = "", onSelect }: { p: Participant; watched: boolean; className?: string; onSelect: (userId: string) => void }) {
  const name = useDisplayName(p.userId, p.username);
  const label = t("voice.stream.show", { name });
  return (
    <li data-stream-tile={p.userId} className={`relative edge aspect-[16/10] min-w-0 overflow-hidden rounded-panel bg-raise shadow-e2 ${className}`}>
      <Tooltip label={label}>
        <button type="button" aria-label={label} onClick={() => onSelect(p.userId)} className="absolute inset-0 block size-full bg-transparent text-ink-muted transition-colors duration-(--duration-fast) hover:bg-white/6">
          {watched && p.screen ? (
            <Video source={p.screen} fit="contain" />
          ) : (
            <span aria-hidden="true" className="grid h-full place-items-center">
              <Monitor size={32} />
            </span>
          )}
        </button>
      </Tooltip>
      <div className="pointer-events-none absolute bottom-2 left-2 z-1 flex max-w-[calc(100%-16px)] items-center gap-1.5">
        <span className="min-w-0 truncate rounded-control bg-surface-0/80 px-2.5 py-1 text-caption font-medium text-ink">{t("voice.screenOf", { name })}</span>
        <LiveBadge />
      </div>
    </li>
  );
}
