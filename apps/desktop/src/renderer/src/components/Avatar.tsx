import type { CSSProperties } from "react";
import type { PresenceStatus } from "@loop/shared";
import { avatarColor, initials } from "../lib/text";
import { StatusDot } from "./StatusDot";

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

const cuts = { 1: "bg-surface-1", 2: "bg-surface-2", 3: "bg-surface-3" } as const;

/** An avatar with its status badge in the corner; `ring` is the surface behind it (the badge's cut-out edge). */
export function PresenceAvatar({ id, name, status, ring = 1, size = 14, labelled = true, className }: { id: string; name: string; status: PresenceStatus; ring?: keyof typeof cuts; size?: number; labelled?: boolean; className?: string }) {
  return (
    <span className="relative inline-grid shrink-0">
      <Avatar id={id} name={name} className={className} />
      <span className="absolute -right-1 -bottom-1">
        <StatusDot status={status} size={size} cut={cuts[ring]} labelled={labelled} />
      </span>
    </span>
  );
}
