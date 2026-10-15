import { Moon } from "@phosphor-icons/react";
import type { PresenceStatus } from "@loop/shared";
import { statusLabel } from "../lib/presence";

/**
 * The status shapes: online = green dot, idle = yellow crescent, dnd = red dot with a bar, offline = hollow ring (the
 * shape differs, so colour is never the only cue). `cut` is the surface behind it (a bg class): the badge gets a
 * same-coloured 2px edge, which cuts it out of an avatar. `labelled` adds the screen-reader text (leave it off where
 * the status is written next to the dot).
 */
export function StatusDot({ status, size = 12, cut, labelled = true }: { status: PresenceStatus; size?: number; cut?: string; labelled?: boolean }) {
  const edge = cut ? 2 : 0;
  const box = size + 2 * edge;
  return (
    <span aria-hidden={labelled ? undefined : true} className={`inline-grid shrink-0 place-items-center rounded-full ${cut ?? ""}`} style={{ width: box, height: box }}>
      {status === "online" && <span aria-hidden="true" className="rounded-full bg-presence-on" style={{ width: size, height: size }} />}
      {status === "idle" && <Moon aria-hidden="true" weight="fill" size={size + 2} className="text-presence-idle" />}
      {status === "dnd" && (
        <span aria-hidden="true" className="grid place-items-center rounded-full bg-presence-dnd" style={{ width: size, height: size }}>
          <span className="rounded-full bg-surface-0" style={{ width: size * 0.55, height: Math.max(2, size * 0.18) }} />
        </span>
      )}
      {status === "offline" && <span aria-hidden="true" className="rounded-full border-2 border-ink-faint" style={{ width: size, height: size }} />}
      {labelled && <span className="sr-only">{statusLabel(status)}</span>}
    </span>
  );
}
