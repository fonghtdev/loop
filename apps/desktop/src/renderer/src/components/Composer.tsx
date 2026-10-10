import { PaperPlaneRight } from "@phosphor-icons/react";
import { useId, useState, type KeyboardEvent } from "react";
import { t } from "../i18n/t";
import { chat } from "../lib/app";
import { COUNTER_FROM, isSubmitKey, MAX_MESSAGE_LENGTH } from "../lib/text";

/** Native key event fields for `isSubmitKey` (React's synthetic event hides isComposing/keyCode on nativeEvent). */
export const submitKey = (e: KeyboardEvent) =>
  isSubmitKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode });

/** Multiline input: Enter sends, Shift+Enter breaks the line, IME confirmations never send. */
export function Composer({ channelId, channelName, canSend, ready }: { channelId: string; channelName: string; canSend: boolean; ready: boolean }) {
  const [text, setText] = useState("");
  const counterId = useId();
  const length = text.trim().length;
  const over = length > MAX_MESSAGE_LENGTH;
  const disabled = !ready || !canSend;

  function send() {
    const content = text.trim();
    if (!content || over || disabled) return;
    void chat.send(channelId, content);
    setText("");
  }

  const placeholder = !ready ? t("composer.loading") : canSend ? t("composer.placeholder", { name: channelName }) : t("composer.noPermission");
  return (
    <div className="shrink-0 px-4 pb-4">
      <div className={`flex items-end gap-2 rounded-panel border bg-surface-3 py-1.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-moss-300 pr-1.5 pl-4 ${over ? "border-danger" : "border-line-strong"}`}>
        <textarea
          aria-label={t("composer.label", { name: channelName })}
          aria-describedby={counterId}
          aria-invalid={over || undefined}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (!submitKey(e)) return;
            e.preventDefault();
            send();
          }}
          className="max-h-[40vh] min-h-10 flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 text-ink [field-sizing:content] placeholder:text-ink-faint focus-visible:outline-none disabled:cursor-not-allowed"
        />
        <button
          type="button"
          onClick={send}
          disabled={disabled || !length || over}
          aria-label={t("composer.send")}
          title={t("composer.send")}
          className="grid size-10 shrink-0 place-items-center rounded-control text-moss-300 transition-colors duration-(--duration-fast) hover:bg-surface-4 disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent"
        >
          <PaperPlaneRight aria-hidden="true" weight="fill" />
        </button>
      </div>
      <p id={counterId} aria-live="polite" className={`mt-1 h-4 px-2 text-right text-xs ${over ? "font-semibold text-danger" : "text-ink-faint"}`}>
        {length >= COUNTER_FROM ? (over ? t("composer.over", { count: String(length - MAX_MESSAGE_LENGTH) }) : t("composer.remaining", { count: String(MAX_MESSAGE_LENGTH - length) })) : ""}
      </p>
    </div>
  );
}
