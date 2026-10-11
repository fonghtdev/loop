import type { CSSProperties } from "react";
import { t } from "../i18n/t";
import { avatarColor, initials } from "../lib/text";

// Literal class names so Tailwind generates them (index = avatarColor()).
const backgrounds = ["", "bg-avatar-1", "bg-avatar-2", "bg-avatar-3", "bg-avatar-4", "bg-avatar-5", "bg-avatar-6"];

/**
 * Initials on a colour that depends only on `id`. Decorative: the name is always shown or labelled next to it.
 * `speaking` (when given, true or false) adds the orbit-arc ring; its strength is the CSS variable --lv = `level`
 * (0..1) while speaking, 0 otherwise, so the audio meter only sets a variable and CSS does the smoothing.
 */
export function Avatar({ id, name, className = "size-10 rounded-full text-sm", speaking, level = 1 }: { id: string; name: string; className?: string; speaking?: boolean; level?: number }) {
  return (
    <span
      aria-hidden="true"
      style={speaking === undefined ? undefined : ({ "--lv": speaking ? level : 0 } as CSSProperties)}
      className={`grid shrink-0 place-items-center font-display font-bold text-ink select-none ${backgrounds[avatarColor(id)]} ${speaking === undefined ? "" : "speaking-ring"} ${className}`}
    >
      {initials(name)}
    </span>
  );
}

const rings = { 1: "ring-surface-1", 2: "ring-surface-2" } as const;

/** An avatar with the online dot when `online`; `ring` is the surface behind it (the dot's cut-out edge). */
export function PresenceAvatar({ id, name, online, ring = 1, className }: { id: string; name: string; online: boolean; ring?: keyof typeof rings; className?: string }) {
  return (
    <span className="relative inline-grid shrink-0">
      <Avatar id={id} name={name} className={className} />
      {online && (
        <>
          <span aria-hidden="true" className={`absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full bg-presence-on shadow-[0_0_6px_var(--color-glow)] ring-2 ${rings[ring]}`} />
          <span className="sr-only">{t("presence.online")}</span>
        </>
      )}
    </span>
  );
}
