import { useLayoutEffect, useRef } from "react";
import { drawLogo } from "../lib/auth-motion";

/** Loop's mark: one continuous stroke that loops into a speech-bubble tail. `animate` draws it once (after `delay` ms). Original artwork. */
export function LogoMark({ className = "", animate = false, delay = 0 }: { className?: string; animate?: boolean; delay?: number }) {
  const path = useRef<SVGPathElement>(null);
  useLayoutEffect(() => {
    if (!animate || !path.current) return;
    const drawing = drawLogo(path.current, delay);
    return () => void drawing?.revert();
  }, [animate, delay]);
  return (
    <svg viewBox="0 0 40 40" fill="none" aria-hidden="true" className={className}>
      <path
        ref={path}
        d="M6.5 33.5 L11.81 28.19 A13 13 0 1 1 18.74 31.8"
        pathLength={1}
        stroke="currentColor"
        strokeWidth={4.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={animate ? 1 : undefined}
      />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark className="size-9 text-moss-300" />
      <span className="font-display text-[28px] leading-none font-extrabold tracking-tight text-ink">loop</span>
    </span>
  );
}
