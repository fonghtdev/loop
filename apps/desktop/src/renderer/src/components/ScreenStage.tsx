import { ArrowsOut, Eye, EyeSlash, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { voice } from "../lib/app";
import { useDisplayName, useNameOf } from "../lib/identity-hooks";
import { viewersOf } from "../lib/stream-watch";
import type { Participant } from "../lib/voice-presence";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { LiveBadge } from "./LiveBadge";
import { Video } from "./ParticipantTile";
import { Tooltip } from "./Tooltip";

const barButton = "grid size-8 place-items-center rounded-control bg-surface-0/80 text-ink transition-colors duration-(--duration-fast) hover:bg-surface-4";

/** Mute toggle and volume slider of one stream's sound (the viewer's side only; the person's microphone is not touched). */
function StreamSound({ userId }: { userId: string }) {
  const volume = useStore(voice.store, (s) => s.streamVolume[userId] ?? 1);
  const muted = useStore(voice.store, (s) => !!s.streamMuted[userId]);
  const label = t(muted ? "voice.stream.unmute" : "voice.stream.mute");
  const percent = Math.round(volume * 100);
  return (
    <>
      <Tooltip label={label}>
        <button type="button" aria-label={label} aria-pressed={muted} onClick={() => voice.setStreamMuted(userId, !muted)} className={barButton}>
          {muted ? <SpeakerSlash aria-hidden="true" /> : <SpeakerHigh aria-hidden="true" />}
        </button>
      </Tooltip>
      <input type="range" min={0} max={100} step={5} value={muted ? 0 : percent} aria-label={t("voice.stream.volume")} aria-valuetext={t("voice.stream.percent", { percent: String(muted ? 0 : percent) })} onChange={(e) => (voice.setStreamMuted(userId, false), voice.setStreamVolume(userId, Number(e.target.value) / 100))} className="h-8 w-24 accent-moss-400" />
    </>
  );
}

const SHOWN_VIEWERS = 5;

/** Who watches this stream (their own claim, see voice-flags): a stack of avatars and the count; nothing while nobody does. */
function Viewers({ streamerId, className = "" }: { streamerId: string; className?: string }) {
  const participants = useStore(voice.store, (s) => s.participants);
  const viewers = viewersOf(participants, streamerId);
  const nameOf = useNameOf();
  if (!viewers.length) return null;
  const label = t("voice.stream.viewers", { count: String(viewers.length) });
  const names = viewers.map((v) => nameOf(v.userId, v.username)).join(", ");
  return (
    <Tooltip label={names}>
      <div role="group" aria-label={`${label}: ${names}`} data-viewers={viewers.length} className={`flex items-center gap-2 rounded-control bg-surface-0/80 py-1 pr-2.5 pl-1.5 text-caption font-medium text-ink ${className}`}>
        <span className="flex -space-x-1.5">
          {viewers.slice(0, SHOWN_VIEWERS).map((v) => (
            <Avatar key={v.userId} id={v.userId} name={nameOf(v.userId, v.username)} className="size-5 rounded-full text-[9px] ring-2 ring-surface-0" />
          ))}
        </span>
        <span aria-hidden="true">{label}</span>
      </div>
    </Tooltip>
  );
}

/**
 * A shared screen shown big (never cropped), named after its owner. The bar (inside the same <figure>, so it stays in real
 * full screen; Esc leaves it) has fullscreen and, for someone else's stream, its sound controls and "Dừng xem".
 * Your own share has no sound controls (no feedback) and nothing to stop watching.
 */
export function ScreenStage({ p }: { p: Participant }) {
  const box = useRef<HTMLElement>(null);
  const label = t("voice.screenOf", { name: useDisplayName(p.userId, p.username) });
  return (
    <figure ref={box} data-screen={p.userId} aria-label={label} className="relative m-0 min-h-0 flex-1 overflow-hidden rounded-panel bg-surface-0 shadow-e2">
      {p.screen ? <Video source={p.screen} fit="contain" /> : <p className="grid h-full place-items-center text-small text-ink-muted">{t("voice.stream.waiting")}</p>}
      <Viewers streamerId={p.userId} className="absolute top-2 left-2" />
      <figcaption className="absolute bottom-2 left-2 max-w-[calc(100%-64px)] truncate rounded-control bg-surface-0/80 px-2.5 py-1 text-caption font-medium text-ink">{label}</figcaption>
      <div className="absolute right-2 bottom-2 flex items-center gap-2 rounded-control bg-surface-0/60 p-1">
        {!p.isLocal && (
          <>
            <StreamSound userId={p.userId} />
            <Tooltip label={t("voice.stream.stop")}>
              <button type="button" aria-label={t("voice.stream.stop")} onClick={() => voice.unwatch(p.userId)} className={barButton}>
                <EyeSlash aria-hidden="true" />
              </button>
            </Tooltip>
          </>
        )}
        <Tooltip label={t("voice.screenFullscreen")}>
          <button type="button" aria-label={t("voice.screenFullscreen")} onClick={() => void box.current?.requestFullscreen().catch(() => undefined)} className={barButton}>
            <ArrowsOut aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    </figure>
  );
}

/** Someone else's stream not being watched yet: nothing plays or downloads until "Xem stream". */
export function StreamCard({ p }: { p: Participant }): ReactNode {
  return (
    <div data-stream={p.userId} className="grid min-h-0 flex-1 place-items-center rounded-panel bg-raise shadow-e2 edge">
      <div className="flex flex-col items-center gap-3 p-5 text-center">
        <LiveBadge />
        <p className="text-body font-medium text-ink">{t("voice.stream.card", { name: useDisplayName(p.userId, p.username) })}</p>
        <Viewers streamerId={p.userId} />
        <Button type="button" onClick={() => voice.watch(p.userId)}>
          <Eye aria-hidden="true" />
          {t("voice.stream.watch")}
        </Button>
      </div>
    </div>
  );
}
