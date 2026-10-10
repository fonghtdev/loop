import { Microphone, MicrophoneSlash, PhoneDisconnect, SpeakerHigh, SpeakerSlash, VideoCamera, VideoCameraSlash } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { calls, voice } from "../lib/app";
import { isActive } from "../lib/voice-hooks";

function Control({ label, title, pressed, tone = "off", disabled, onClick, children }: { label: string; title: string; pressed?: boolean; tone?: "off" | "on"; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  // "off" controls (mute, deafen) turn red when pressed; "on" controls (camera) turn green
  const look = pressed ? (tone === "off" ? "bg-danger-bg text-danger" : "bg-moss-900 text-moss-200") : "bg-surface-3 text-ink hover:bg-surface-4";
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`grid size-10 place-items-center rounded-control transition-colors duration-(--duration-fast) disabled:cursor-not-allowed disabled:opacity-60 ${look}`}
    >
      {children}
    </button>
  );
}

/** The active session, always visible above the account strip: status, where, and the controls. */
export function VoiceBar() {
  const v = useStore(voice.store);
  const ringing = useStore(calls.store, (s) => s.ringing);
  if (!isActive(v.status) || !v.target) return null;

  const ready = v.status === "connected";
  const where = ringing ? t("voice.bar.ringing", { name: v.target.name }) : v.target.kind === "dm" ? t("voice.bar.call", { name: v.target.name }) : t("voice.bar.channel", { name: v.target.name });
  const status = v.status === "reconnecting" ? t("voice.status.reconnecting") : ready ? t("voice.status.connected") : t("voice.status.connecting");
  const leaveLabel = ringing ? t("voice.cancelCall") : v.target.kind === "dm" ? t("voice.hangup") : t("voice.leave");
  const micTitle = !v.canSpeak ? t("voice.micNoSpeak") : v.deafened ? t("voice.micDeafened") : t("voice.mic");
  const camTitle = v.canVideo ? t("voice.camera") : t("voice.cameraNoVideo");

  return (
    <section aria-label={t("voice.bar.label")} className="flex shrink-0 flex-col gap-2 border-t border-line bg-surface-1 p-3">
      <div className="min-w-0">
        <p aria-live="polite" className={`truncate text-sm font-semibold ${ready ? "text-moss-300" : "text-ink-muted"}`}>
          {status}
        </p>
        <p title={where} className="truncate text-xs text-ink-muted">
          {where}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <Control label={t("voice.mic")} title={micTitle} pressed={!v.micEnabled} disabled={!ready || !v.canSpeak || v.deafened} onClick={() => void voice.toggleMic()}>
          {v.micEnabled ? <Microphone aria-hidden="true" /> : <MicrophoneSlash aria-hidden="true" />}
        </Control>
        <Control label={t("voice.deafen")} title={t("voice.deafen")} pressed={v.deafened} disabled={!ready} onClick={() => void voice.toggleDeafen()}>
          {v.deafened ? <SpeakerSlash aria-hidden="true" /> : <SpeakerHigh aria-hidden="true" />}
        </Control>
        <Control label={t("voice.camera")} title={camTitle} tone="on" pressed={v.camEnabled} disabled={!ready || !v.canVideo} onClick={() => void voice.toggleCamera()}>
          {v.camEnabled ? <VideoCamera aria-hidden="true" /> : <VideoCameraSlash aria-hidden="true" />}
        </Control>
        <button
          type="button"
          aria-label={leaveLabel}
          title={leaveLabel}
          onClick={() => (ringing ? calls.cancel() : voice.leave())}
          className="ml-auto grid size-10 place-items-center rounded-control bg-danger text-on-moss transition-opacity duration-(--duration-fast) hover:opacity-90"
        >
          <PhoneDisconnect aria-hidden="true" />
        </button>
      </div>
      {v.mediaNote && (
        <p aria-live="polite" className="text-xs leading-relaxed text-warning">
          {v.mediaNote}
        </p>
      )}
    </section>
  );
}
