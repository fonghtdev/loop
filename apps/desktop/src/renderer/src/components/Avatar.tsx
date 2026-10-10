import { t } from "../i18n/t";
import { avatarColor, initials } from "../lib/text";

// Literal class names so Tailwind generates them (index = avatarColor()).
const backgrounds = ["", "bg-avatar-1", "bg-avatar-2", "bg-avatar-3", "bg-avatar-4", "bg-avatar-5", "bg-avatar-6"];

/** Initials on a colour that depends only on `id`. Decorative: the name is always shown or labelled next to it. */
export function Avatar({ id, name, className = "size-10 rounded-full text-sm" }: { id: string; name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center font-display font-bold text-ink select-none ${backgrounds[avatarColor(id)]} ${className}`}
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
          <span aria-hidden="true" className={`absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full bg-moss-400 ring-2 ${rings[ring]}`} />
          <span className="sr-only">{t("presence.online")}</span>
        </>
      )}
    </span>
  );
}
