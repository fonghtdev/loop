import { Info, WarningCircle, WifiSlash } from "@phosphor-icons/react";
import type { ReactNode } from "react";

const tones = {
  warning: { box: "bg-warning-bg text-ink", icon: <Info className="text-warning" /> },
  danger: { box: "bg-danger-bg text-ink", icon: <WarningCircle className="text-danger" /> },
  offline: { box: "bg-warning-bg text-ink", icon: <WifiSlash className="text-warning" /> },
};

/** An inline notice. Live-region announcing is the job of the container it is rendered into. */
export function Banner({ tone, children, className = "" }: { tone: keyof typeof tones; children: ReactNode; className?: string }) {
  return (
    <div className={`flex items-start gap-2.5 rounded-card px-4 py-3 shadow-e1 text-sm leading-relaxed ${tones[tone].box} ${className}`}>
      <span className="mt-0.5 shrink-0" aria-hidden="true">
        {tones[tone].icon}
      </span>
      <span>{children}</span>
    </div>
  );
}
