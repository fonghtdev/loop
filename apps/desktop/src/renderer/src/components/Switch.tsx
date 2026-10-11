import { useId, type ReactNode } from "react";

/**
 * A labelled on/off setting: the whole row is one native button with role="switch" (Space/Enter toggle, state in
 * aria-checked), the description is its accessible description. Track and knob are plain CSS.
 */
export function Switch({ label, description, checked, onChange, disabled }: { label: string; description?: ReactNode; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-l`}
      aria-describedby={description ? `${id}-d` : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex min-h-14 w-full items-center gap-4 rounded-control px-3 py-2 text-left transition-colors focus-visible:outline-offset-[-2px] focus-visible:shadow-none duration-(--duration-fast) hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-70"
    >
      <span className="min-w-0 flex-1">
        <span id={`${id}-l`} className="block text-[15px] font-medium">
          {label}
        </span>
        {description && (
          <span id={`${id}-d`} className="mt-0.5 block text-[13px] leading-relaxed text-ink-muted">
            {description}
          </span>
        )}
      </span>
      <span aria-hidden="true" className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-(--duration-fast) ${checked ? "border-moss-400 bg-moss-400 shadow-[0_0_10px_-2px_var(--color-glow)]" : "border-line-strong bg-surface-4"}`}>
        <span
          className={`absolute top-1/2 size-4 -translate-y-1/2 rounded-full transition-[left] duration-(--duration-base) ease-(--ease-spring) ${checked ? "left-[calc(100%-1.25rem)] bg-on-moss" : "left-1 bg-ink-muted"}`}
        />
      </span>
    </button>
  );
}
