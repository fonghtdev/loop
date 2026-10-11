import type { ReactNode } from "react";

/**
 * Content that folds away to nothing and comes back (the register-only field of the auth card). It animates the
 * grid row, the one layout transition the motion rules allow, so the card grows and shrinks without a jump. Closed
 * content is invisible and inert (no focus, not read out), but never unmounted, so typed values survive.
 * `offset` cancels the flex gap that would otherwise remain around the collapsed row, e.g. "-mb-4" for gap-4.
 */
export function Collapse({ open, offset, children }: { open: boolean; offset: string; children: ReactNode }) {
  return (
    <div
      inert={!open}
      className={`grid transition-[grid-template-rows,margin,opacity,visibility] duration-(--duration-slow) ease-(--ease-out-soft) ${open ? "visible grid-rows-[1fr] opacity-100" : `invisible grid-rows-[0fr] opacity-0 ${offset}`}`}
    >
      {/* the negative margin + padding leave room for the focus halo, which overflow would otherwise clip */}
      <div className="-m-2 min-h-0 overflow-hidden p-2">{children}</div>
    </div>
  );
}
