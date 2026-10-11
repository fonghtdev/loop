import { ArrowSquareOut, CellSignalFull, CellSignalLow, PhoneDisconnect, VideoCamera, VideoCameraSlash } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { calls, voice } from "../lib/app";
import { openVoiceRoom } from "../lib/channel-open";
import { useGuilds } from "../lib/queries";
import { panelModel } from "../lib/panel-model";
import { Tooltip } from "./Tooltip";

/** A 40 px control of the panel (`wide` = a square button that shares the row). */
export function Control({ label, hint, pressed, tone = "off", disabled, wide, onClick, children }: { label: string; hint: string; pressed?: boolean; tone?: "off" | "on"; disabled?: boolean; wide?: boolean; onClick: () => void; children: ReactNode }) {
  // "off" controls (mute, deafen) turn red when pressed; "on" controls (camera) turn green
  const look = pressed ? (tone === "off" ? "bg-danger-bg text-danger" : "bg-moss-900 text-moss-200") : "bg-surface-1 text-ink hover:bg-surface-4";
  // the tooltip hangs on a wrapper: a disabled button gets no pointer events, and its reason (title) must still show
  return (
    <Tooltip label={hint}>
      <span className={wide ? "flex flex-1" : "inline-flex"}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
          className={`grid ${wide ? "h-10 w-full" : "size-10"} place-items-center rounded-control transition-colors duration-(--duration-fast) active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-60 ${look}`}
        >
          {children}
        </button>
      </span>
    </Tooltip>
  );
}

/** The call header of the bottom panel: where we are connected, hang up, and the actions of the session. */
export function VoiceBar() {
  const v = useStore(voice.store);
  const ringing = useStore(calls.store, (s) => !!s.ringing);
  const guilds = useGuilds().data;
  const m = panelModel(v, ringing);
  if (!m || !v.target) return null;

  const ready = m.status === "connected";
  const guild = guilds?.find((g) => g.id === v.target?.guildId)?.name;
  const where = ringing ? t("voice.bar.ringing", { name: v.target.name }) : m.dm || !guild ? v.target.name : t("voice.bar.channel", { name: v.target.name, guild });
  const status = m.status === "reconnecting" ? t("voice.status.reconnecting") : ready ? t(m.dm ? "voice.status.connectedCall" : "voice.status.connected") : t("voice.status.connecting");
  const leaveLabel = t(m.leave === "cancel" ? "voice.cancelCall" : m.leave === "hangup" ? "voice.hangup" : "voice.leave");
  const camTitle = v.canVideo ? t("voice.camera") : t("voice.cameraNoVideo");
  const Signal = ready ? CellSignalFull : CellSignalLow;

  return (
    <section aria-label={t("voice.bar.label")} className="flex flex-col gap-2 p-3 pb-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p aria-live="polite" className={`flex items-center gap-2 truncate text-small font-semibold ${ready ? "text-moss-300" : "text-ink-muted"}`}>
            {ringing && (
              <span aria-hidden="true" className="relative size-2 shrink-0 rounded-full bg-cosmic-300">
                <span data-ripple className="absolute inset-0 animate-ripple rounded-full border border-cosmic-300" />
              </span>
            )}
            {status}
          </p>
          <Tooltip label={where}>
            <p className="truncate text-caption text-ink-muted">{where}</p>
          </Tooltip>
        </div>
        <Signal aria-hidden="true" size={20} className={`shrink-0 ${ready ? "text-moss-300" : "text-ink-muted"}`} />
        <span className="inline-flex">
          <Tooltip label={leaveLabel}>
            <button
              type="button"
              aria-label={leaveLabel}
              onClick={() => (ringing ? calls.cancel() : voice.leave())}
              className="grid size-10 place-items-center rounded-control bg-danger text-on-moss transition-opacity duration-(--duration-fast) hover:opacity-90 active:scale-[.98]"
            >
              <PhoneDisconnect aria-hidden="true" />
            </button>
          </Tooltip>
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Control wide label={t("voice.camera")} hint={camTitle} tone="on" pressed={v.camEnabled} disabled={!m.camera} onClick={() => void voice.toggleCamera()}>
          {v.camEnabled ? <VideoCamera aria-hidden="true" /> : <VideoCameraSlash aria-hidden="true" />}
        </Control>
        {m.openRoom && (
          <Control wide label={t("voice.openRoom")} hint={t("voice.openRoom")} onClick={openVoiceRoom}>
            <ArrowSquareOut aria-hidden="true" />
          </Control>
        )}
      </div>
      {v.mediaNote && (
        <p aria-live="polite" className="text-xs leading-relaxed text-warning">
          {v.mediaNote}
        </p>
      )}
    </section>
  );
}
