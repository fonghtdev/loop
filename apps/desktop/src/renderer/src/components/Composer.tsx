import { Paperclip, PaperPlaneRight } from "@phosphor-icons/react";
import { ATTACHMENT_TYPES } from "@loop/shared";
import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { t } from "../i18n/t";
import { chat } from "../lib/app";
import { canSend as sendAllowed } from "../lib/attachment-machine";
import type { ComposerFiles } from "../lib/composer-files";
import type { ConvKey } from "../lib/conversation";
import { nameForPasted, pastedFiles } from "../lib/drop";
import { COUNTER_FROM, isSubmitKey, MAX_MESSAGE_LENGTH } from "../lib/text";
import { AttachmentTray } from "./AttachmentTray";
import { Tooltip } from "./Tooltip";

/** Native key event fields for `isSubmitKey` (React's synthetic event hides isComposing/keyCode on nativeEvent). */
export const submitKey = (e: KeyboardEvent) =>
  isSubmitKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode });

type Props = {
  convKey: ConvKey;
  /** Accessible name and placeholder of the text box. */
  label: string;
  placeholder: string;
  files: ComposerFiles;
  ready: boolean;
  /** Why writing is closed (no permission, not a friend...); shown as the placeholder. null = open. */
  closedReason: string | null;
};

/** Multiline input: Enter sends, Shift+Enter breaks the line, IME confirmations never send; files by button, drop (in Conversation) or paste. */
export function Composer({ convKey, label, placeholder, files, ready, closedReason }: Props) {
  const [text, setText] = useState("");
  const counterId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const length = text.trim().length;
  const over = length > MAX_MESSAGE_LENGTH;
  const disabled = !ready || closedReason !== null;
  const canSend = sendAllowed({ disabled, over, textLength: length, files: files.items.map((i) => i.state) });

  function send() {
    if (!canSend) return;
    chat.send(convKey, { content: text.trim(), attachments: files.queue.take() });
    setText("");
    files.clearNotices();
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = pastedFiles(e.clipboardData);
    if (!pasted.length) return; // plain text: the normal paste
    e.preventDefault();
    files.add(pasted.map(nameForPasted));
  }

  return (
    <div className="shrink-0 px-4 pb-4">
      {files.notices.length > 0 && (
        <div role="alert" className="mb-2 flex flex-col gap-1 rounded-control bg-danger-bg px-3 py-2 text-[13px] text-ink">
          {files.notices.map((n, i) => (
            <p key={i} className="[overflow-wrap:anywhere]">
              {n}
            </p>
          ))}
        </div>
      )}
      <AttachmentTray items={files.items} onRetry={files.queue.retry} onRemove={files.queue.remove} />
      <div
        className={`relative edge flex items-end gap-1 rounded-card bg-surface-3 p-1.5 shadow-e2 transition-shadow duration-(--duration-base) focus-within:shadow-[var(--shadow-e2),0_0_0_3px_var(--color-cosmic-glow-soft)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-cosmic-300 ${over ? "ring-1 ring-danger" : ""}`}
      >
        <Tooltip label={t("attachment.pick")}>
          <span className="inline-flex">
            <button
              type="button"
              onClick={() => picker.current?.click()}
              disabled={disabled}
              aria-label={t("attachment.pick")}
              className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-4 hover:text-ink active:scale-[.98] disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent"
            >
              <Paperclip aria-hidden="true" />
            </button>
          </span>
        </Tooltip>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept={ATTACHMENT_TYPES.join(",")}
          data-testid="file-input"
          onChange={(e) => {
            files.add(Array.from(e.target.files ?? []));
            e.target.value = ""; // picking the same file again must fire change
          }}
        />
        <textarea
          aria-label={label}
          aria-describedby={counterId}
          aria-invalid={over || undefined}
          placeholder={!ready ? t("composer.loading") : (closedReason ?? placeholder)}
          disabled={disabled}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (!submitKey(e)) return;
            e.preventDefault();
            send();
          }}
          className="max-h-[40vh] min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-6 text-ink [field-sizing:content] placeholder:text-ink-faint focus-visible:outline-none disabled:cursor-not-allowed"
        />
        <Tooltip label={t("composer.send")} kbd="Enter">
          <span className="inline-flex">
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              aria-label={t("composer.send")}
              className="grid size-10 shrink-0 place-items-center rounded-control bg-moss text-on-moss shadow-moss transition-[filter,scale] duration-(--duration-fast) hover:brightness-105 active:scale-[.98] disabled:cursor-not-allowed disabled:bg-surface-4 disabled:bg-none disabled:text-ink-faint disabled:shadow-none disabled:hover:brightness-100"
            >
              <PaperPlaneRight aria-hidden="true" weight="fill" />
            </button>
          </span>
        </Tooltip>
      </div>
      <p id={counterId} aria-live="polite" className={`numeric mt-1 h-4 px-2 text-right text-caption ${over ? "font-semibold text-danger" : "text-ink-faint"}`}>
        {length >= COUNTER_FROM ? (over ? t("composer.over", { count: String(length - MAX_MESSAGE_LENGTH) }) : t("composer.remaining", { count: String(MAX_MESSAGE_LENGTH - length) })) : ""}
      </p>
    </div>
  );
}
