/**
 * The look of a selectable row in a column (channels, DMs, the Friends entry): the selected row has the cosmic wash and a
 * gradient bar on its left edge (a pseudo-element, so nothing shifts), the others a quiet hover; unread rows are bolder.
 * The caller adds the size (height, width); `spacing` is the gap and horizontal padding.
 */
export const navRow = (active: boolean, unread = false, spacing = "gap-2 px-2.5") =>
  `relative flex min-w-0 items-center ${spacing} rounded-control text-left text-[15px] transition-colors duration-(--duration-fast) after:absolute after:inset-y-2.5 after:left-0 after:w-0.5 after:rounded-full after:bg-[linear-gradient(180deg,var(--color-cosmic-200),var(--color-cosmic-400))] after:transition-[opacity,scale] after:duration-(--duration-slow) after:ease-(--ease-out-soft) active:scale-[.98] ${
    active
      ? "bg-[linear-gradient(90deg,var(--color-cosmic-wash),rgb(255_255_255/.05)_60%)] font-semibold text-ink shadow-[inset_0_1px_0_var(--color-highlight)] after:opacity-100"
      : `after:scale-y-30 after:opacity-0 hover:bg-white/[.045] ${unread ? "font-bold text-ink" : "text-ink-muted hover:text-ink"}`
  }`;
