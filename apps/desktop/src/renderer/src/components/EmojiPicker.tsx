import { useRef, useState, type KeyboardEvent } from "react";
import { t } from "../i18n/t";
import { EMOJI_GROUPS, moveEmojiFocus } from "../lib/emoji-data";

const NAV_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];

/**
 * A small grid of common emoji in four groups (no search). One tab stop with arrow/Home/End movement (roving
 * tabindex), so it is quick to cross by keyboard. Meant to sit in a menu popover (`RowMenu` focuses the first
 * `[data-nav-item]` when it opens); the composer can reuse it as is.
 */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [active, setActive] = useState(0);
  const cells = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent) {
    if (!NAV_KEYS.includes(e.key)) return;
    const next = moveEmojiFocus(active, e.key);
    e.preventDefault();
    e.stopPropagation(); // the menu's own Up/Down walk would fight this one
    setActive(next);
    cells.current[next]?.focus();
  }

  let index = -1;
  return (
    <div role="group" aria-label={t("emoji.picker")} onKeyDown={onKeyDown} className="flex flex-col gap-2">
      {EMOJI_GROUPS.map((g) => (
        <div key={g.label} role="group" aria-label={t(g.label)}>
          <p className="px-1 pb-1 text-caption font-semibold text-ink-muted">{t(g.label)}</p>
          <div className="grid grid-cols-8">
            {g.emoji.map((emoji) => {
              const i = ++index;
              return (
                <button
                  key={emoji}
                  ref={(el) => {
                    cells.current[i] = el;
                  }}
                  type="button"
                  data-nav-item
                  tabIndex={i === active ? 0 : -1}
                  aria-label={emoji}
                  onFocus={() => setActive(i)}
                  onClick={() => onPick(emoji)}
                  className="grid size-10 place-items-center rounded-control text-xl hover:bg-white/8 focus-visible:bg-cosmic-wash focus-visible:outline-offset-[-2px] focus-visible:shadow-none active:scale-[.98]"
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
