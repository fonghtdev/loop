import { Headphones, MicrophoneSlash, type IconProps } from "@phosphor-icons/react";
import { t } from "../i18n/t";
import { useIndicators } from "../lib/voice-hooks";
import type { Participant } from "../lib/voice-presence";

/** Phosphor has no slashed headphones: the same glyph with a diagonal through it, like its other "-slash" icons. */
export function HeadphonesSlash(props: IconProps) {
  return (
    <Headphones {...props}>
      <line x1="40" y1="40" x2="216" y2="216" stroke="currentColor" strokeWidth="20" strokeLinecap="round" />
    </Headphones>
  );
}

/** The mic-off / headphones-off marks of someone in a room; the same marks in the channel list and on the tiles. */
export function VoiceIndicators({ p, size = 16, className = "" }: { p: Participant; size?: number; className?: string }) {
  const icons = useIndicators(p);
  if (icons.length === 0) return null;
  return (
    <span data-indicators={icons.join(" ")} className={`inline-flex shrink-0 items-center gap-1 text-danger ${className}`}>
      {icons.includes("mic") && (
        <>
          <MicrophoneSlash aria-hidden="true" size={size} />
          <span className="sr-only">{t("voice.state.micOff")}</span>
        </>
      )}
      {icons.includes("deaf") && (
        <>
          <HeadphonesSlash aria-hidden="true" size={size} />
          <span className="sr-only">{t("voice.state.deafOff")}</span>
        </>
      )}
    </span>
  );
}
