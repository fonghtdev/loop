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
