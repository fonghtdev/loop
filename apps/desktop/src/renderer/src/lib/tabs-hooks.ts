import { useLayoutEffect, useRef, type RefObject } from "react";
import { move } from "./motion";
import { indicatorSpot, type Spot } from "./tabs";

/**
 * The sliding indicator under the tabs: one element placed with transform only (translate + stretch), animated through
 * lib/motion when the selected tab changes (an instant jump under reduced motion) and set straight otherwise
 * (first placement, a count changing the tab's width).
 */
export function useTabIndicator(list: RefObject<HTMLDivElement | null>, indicator: RefObject<HTMLSpanElement | null>, tab: string, widths: string) {
  const last = useRef<{ tab: string; spot: Spot } | null>(null);
  useLayoutEffect(() => {
    const selected = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const el = indicator.current;
    if (!selected || !el) return;
    const spot = indicatorSpot(selected.offsetLeft, selected.offsetWidth);
    const from = last.current;
    last.current = { tab, spot };
    if (!from || from.tab === tab) el.style.transform = `translateX(${spot.x}px) scaleX(${spot.scaleX})`;
    else move(el, { x: [from.spot.x, spot.x], scaleX: [from.spot.scaleX, spot.scaleX], ease: "outQuart", duration: 240 });
  }, [tab, widths]); // eslint-disable-line react-hooks/exhaustive-deps
}
