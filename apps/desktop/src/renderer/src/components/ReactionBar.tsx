import { SmileyWink } from "@phosphor-icons/react";
import { t } from "../i18n/t";
import type { Message } from "../lib/chat";
import { EmojiPicker } from "./EmojiPicker";
import { RowMenu } from "./RowMenu";

/** The chips under a message (click toggles ours) and a "+" that opens the picker. `canReact` = may add new ones (SEND in the channel, a friend in a DM). */
export function ReactionBar({ message, canReact, onReact }: { message: Message; canReact: boolean; onReact: (messageId: string, emoji: string) => void }) {
  const reactions = message.reactions ?? [];
  if (!reactions.length) return null;
  return (
    <div role="group" aria-label={t("reaction.group")} className="mt-1 flex flex-wrap items-center gap-1">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          aria-pressed={r.me}
          // taking back our own stays possible when writing is closed (the server allows it); adding does not
          disabled={!canReact && !r.me}
          aria-label={t(r.me ? "reaction.chipOn" : "reaction.chipOff", { emoji: r.emoji, count: String(r.count) })}
          onClick={() => onReact(message.id, r.emoji)}
          className={`relative inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-small transition-colors duration-(--duration-fast) before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-60 ${r.me ? "border-moss-400/60 bg-moss-900 text-moss-200" : "border-line bg-surface-3 text-ink-muted enabled:hover:bg-surface-4"}`}
        >
          <span aria-hidden="true">{r.emoji}</span>
          <span aria-hidden="true" className="numeric">
            {r.count}
          </span>
        </button>
      ))}
      {canReact && (
        <RowMenu
          id={`react-more-${message.id}`}
          label={t("reaction.add")}
          size="size-8"
          width="w-[340px]"
          align="left"
          trigger={<SmileyWink aria-hidden="true" />}
          className="border border-line bg-surface-3"
        >
          {(close) => (
            <EmojiPicker
              onPick={(emoji) => {
                close();
                onReact(message.id, emoji);
              }}
            />
          )}
        </RowMenu>
      )}
    </div>
  );
}
