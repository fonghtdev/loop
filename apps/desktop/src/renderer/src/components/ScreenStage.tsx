import { ArrowsOut } from "@phosphor-icons/react";
import { useRef } from "react";
import { t } from "../i18n/t";
import type { Participant } from "../lib/voice-presence";
import { Video } from "./ParticipantTile";
import { Tooltip } from "./Tooltip";

/** A shared screen shown big (never cropped), named after its owner, with a full-screen button. Esc leaves full screen. */
export function ScreenStage({ p }: { p: Participant & { screen: NonNullable<Participant["screen"]> } }) {
  const box = useRef<HTMLElement>(null);
  const label = t("voice.screenOf", { name: p.username });
  return (
    <figure ref={box} data-screen={p.userId} aria-label={label} className="relative m-0 min-h-0 flex-1 overflow-hidden rounded-panel bg-surface-0 shadow-e2">
      <Video source={p.screen} fit="contain" />
      <figcaption className="absolute bottom-2 left-2 max-w-[calc(100%-64px)] truncate rounded-control bg-surface-0/80 px-2.5 py-1 text-caption font-medium text-ink">{label}</figcaption>
      <div className="absolute right-2 bottom-2">
        <Tooltip label={t("voice.screenFullscreen")}>
          <button type="button" aria-label={t("voice.screenFullscreen")} onClick={() => void box.current?.requestFullscreen().catch(() => undefined)} className="grid size-8 place-items-center rounded-control bg-surface-0/80 text-ink transition-colors duration-(--duration-fast) hover:bg-surface-4">
            <ArrowsOut aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    </figure>
  );
}
