import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip";

export type SegmentOption<V extends string> = {
  value: V;
  /** the visible text, or (with `icon`) the accessible name and the tooltip */
  label: string;
  /** shown instead of the text; the radio keeps `label` as its `aria-label` */
  icon?: ReactNode;
  /** literal classes (Tailwind scans for them): the sliding thumb, and `peer-checked:` text colour of the label */
  thumb?: string;
  on?: string;
};

/**
 * A row of native radios drawn as a segmented control with ONE thumb that slides (CSS transform) behind the chosen
 * label. The radios stay real inputs (`name`, arrows, Space), so the radiogroup semantics are the browser's; whoever
 * wraps this supplies the group (a fieldset with a legend, or `role="radiogroup"` + `labelledBy`).
 */
export function Segmented<V extends string>({
  name,
  options,
  value,
  onChange,
  disabled = false,
  labelledBy,
  radiogroup = false,
}: {
  name: string;
  options: SegmentOption<V>[];
  value: V;
  onChange: (v: V) => void;
  disabled?: boolean;
  labelledBy?: string;
  radiogroup?: boolean;
}) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const chosen = options[index];
  return (
    <div
      role={radiogroup ? "radiogroup" : undefined}
      aria-labelledby={labelledBy}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      className={`relative inline-grid max-w-full rounded-control bg-surface-1 p-1 shadow-[inset_1px_2px_3px_rgb(8_4_28/.55)] ${disabled ? "opacity-60" : ""}`}
    >
      <span
        aria-hidden="true"
        data-seg-thumb
        data-index={index}
        style={{ width: `calc((100% - 0.5rem) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
        className={`absolute inset-y-1 left-1 rounded-sm shadow-e1 transition-[transform,background-color] duration-(--duration-slow) ease-(--ease-spring) ${chosen.thumb ?? "bg-surface-4"}`}
      />
      {options.map((o) => {
        const item = (
          <label key={o.value} className={`relative ${disabled ? "" : "cursor-pointer"}`}>
            <input type="radio" name={name} value={o.value} aria-label={o.icon ? o.label : undefined} checked={o.value === value} disabled={disabled} onChange={() => onChange(o.value)} className="peer sr-only" />
            <span
              className={`grid h-10 ${o.icon ? "min-w-12" : "min-w-24"} place-items-center rounded-sm px-3 text-ui font-medium whitespace-nowrap text-ink-muted transition-colors duration-(--duration-fast) ${o.on ?? "peer-checked:text-ink"} peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-cosmic-300`}
            >
              {o.icon ? (
                <span aria-hidden="true" className="flex">
                  {o.icon}
                </span>
              ) : (
                o.label
              )}
            </span>
          </label>
        );
        return o.icon ? (
          <Tooltip key={o.value} label={o.label}>
            {item}
          </Tooltip>
        ) : (
          item
        );
      })}
    </div>
  );
}
