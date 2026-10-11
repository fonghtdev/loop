import { cloneElement, useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactElement } from "react";
import { createTooltipTimer } from "../lib/tooltip";

type TriggerProps = {
  onMouseEnter?: (e: never) => void;
  onMouseLeave?: (e: never) => void;
  onFocus?: (e: FocusEvent) => void;
  onBlur?: (e: FocusEvent) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  style?: CSSProperties;
};

/**
 * The tooltip of one icon button (replaces the native `title=`; it SUPPLEMENTS the accessible name, which stays an
 * `aria-label`): shows after a delay on hover (400 ms) or keyboard focus (300 ms), hides on leave, blur and Escape, and
 * describes its trigger (`aria-describedby`) while shown. `kbd` is the chip of a shortcut that really exists. It is a
 * native popover anchored to the trigger (`side`: above it, or to its right for the rail), so it is not clipped by
 * scrolling parents; glass exists only while it is shown, and the element exists only then. The trigger may be a
 * wrapper of a disabled button (a disabled button gets no pointer events).
 */
export function Tooltip({ label, kbd, side = "top", children }: { label: string; kbd?: string; side?: "top" | "right"; children: ReactElement<TriggerProps> }) {
  const id = useId();
  const anchor = `--tt-${id.replace(/[^\w-]/g, "")}`;
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof createTooltipTimer>>(null);
  const tip = useRef<HTMLDivElement>(null);
  timer.current ??= createTooltipTimer(
    () => setShown(true),
    () => setShown(false),
  );
  const t = timer.current;

  useEffect(() => () => t.dispose(), [t]);
  useEffect(() => {
    if (!shown) return;
    tip.current?.showPopover();
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && t.escape();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [shown, t]);

  const child = children.props;
  return (
    <>
      {cloneElement(children, {
        "aria-describedby": shown ? id : undefined,
        style: { ...child.style, anchorName: [(child.style as { anchorName?: string } | undefined)?.anchorName, anchor].filter(Boolean).join(", ") } as CSSProperties,
        onMouseEnter: (e: never) => (child.onMouseEnter?.(e), t.enter("hover")),
        onMouseLeave: (e: never) => (child.onMouseLeave?.(e), t.leave()),
        onFocus: (e: FocusEvent) => (child.onFocus?.(e), (e.target as Element).matches(":focus-visible") && t.enter("focus")),
        onBlur: (e: FocusEvent) => (child.onBlur?.(e), t.leave()),
        onKeyDown: (e: KeyboardEvent) => (child.onKeyDown?.(e), e.key === "Escape" && t.escape()),
      } as Partial<TriggerProps>)}
      {shown && (
        <div
          ref={tip}
          id={id}
          role="tooltip"
          popover="manual"
          style={{ positionAnchor: anchor } as CSSProperties}
          className={`pointer-events-none glass m-0 flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-small text-ink [inset:auto] ${
            side === "top" ? "mb-2 [position-area:top] [position-try-fallbacks:flip-block]" : "ml-2 [position-area:right_center] [position-try-fallbacks:flip-inline]"
          }`}>
          {label}
          {kbd && <kbd className="rounded-xs bg-surface-4 px-1.5 py-0.5 text-micro font-semibold text-ink-muted">{kbd}</kbd>}
        </div>
      )}
    </>
  );
}
