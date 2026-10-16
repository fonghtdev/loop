import { t } from "../i18n/t";
import { useNameOf } from "../lib/identity-hooks";
import { labelOf, type Candidate } from "../lib/mentions";
import { Avatar } from "./Avatar";

/**
 * The suggestions under `@`: a listbox the composer drives (focus stays in the text box; it points at the active row
 * with aria-activedescendant). Rows are 40px; the mouse picks on press so the text box keeps its caret.
 */
export function MentionPicker({ id, items, active, onActive, onPick }: { id: string; items: Candidate[]; active: number; onActive: (i: number) => void; onPick: (c: Candidate) => void }) {
  const nameOf = useNameOf();
  return (
    <ul id={id} role="listbox" aria-label={t("mention.listLabel")} className="absolute right-0 bottom-full left-0 z-20 mb-2 max-h-[336px] overflow-y-auto rounded-card bg-raise p-1.5 shadow-e3">
      {items.map((c, i) => {
        const name = nameOf(c.userId, labelOf(c));
        return (
          <li
            key={c.userId}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseMove={() => i !== active && onActive(i)}
            onMouseDown={(e) => {
              e.preventDefault(); // keep the caret in the text box
              onPick(c);
            }}
            className={`flex h-10 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-sm ${i === active ? "bg-cosmic-wash text-ink" : "text-ink-muted"}`}
          >
            <Avatar id={c.userId} name={name} className="size-6 rounded-full text-[10px]" />
            <span className="min-w-0 truncate font-medium text-ink">{name}</span>
            <span className="min-w-0 truncate text-caption text-ink-faint">@{c.username}</span>
            {c.isBot && <span className="shrink-0 rounded-xs bg-surface-4 px-1 text-micro font-bold text-ink-muted">{t("mention.optionBot")}</span>}
          </li>
        );
      })}
    </ul>
  );
}
