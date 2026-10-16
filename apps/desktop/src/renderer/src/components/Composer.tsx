import { ArrowBendUpLeft, Paperclip, PaperPlaneRight, X } from "@phosphor-icons/react";
import { ATTACHMENT_TYPES, type GifResult } from "@loop/shared";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { t } from "../i18n/t";
import { useStore } from "zustand";
import { chat, typingSender } from "../lib/app";
import type { Message } from "../lib/chat";
import { canSend as sendAllowed } from "../lib/attachment-machine";
import type { ComposerFiles } from "../lib/composer-files";
import type { ConvKey } from "../lib/conversation";
import { nameForPasted, pastedFiles } from "../lib/drop";
import { useDisplayName } from "../lib/identity-hooks";
import { activeMention, insertMention, labelOf, rankCandidates, toDraft, toWire, tokenFor, type Candidate, type MentionToken } from "../lib/mentions";
import { cancelsReply } from "../lib/reply";
import { COUNTER_FROM, isSubmitKey, MAX_MESSAGE_LENGTH } from "../lib/text";
import { AttachmentTray } from "./AttachmentTray";
import { GifPicker } from "./GifPicker";
import { MentionPicker } from "./MentionPicker";
import { TypingIndicator } from "./TypingIndicator";
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
  /** The message being answered (shown above the box), and how to drop it. */
  reply: Message | null;
  onCancelReply: () => void;
  /** Members `@` can name here (a channel); omitted in a DM, where there is only one other person. */
  mentionCandidates?: Candidate[];
};

function ReplyBar({ reply, onCancel }: { reply: Message; onCancel: () => void }) {
  const name = useDisplayName(reply.author.id, reply.author.username);
  return (
    <div className="mb-1 flex items-center gap-2 rounded-card bg-surface-3 py-1 pr-1 pl-3 text-small text-ink-muted">
      <ArrowBendUpLeft aria-hidden="true" className="shrink-0" />
      <p className="min-w-0 flex-1 truncate">{t("reply.composing", { name })}</p>
      <Tooltip label={t("reply.cancel")} kbd="Esc">
        <button type="button" onClick={onCancel} aria-label={t("reply.cancel")} className="grid size-10 shrink-0 place-items-center rounded-control hover:bg-surface-4 hover:text-ink active:scale-[.98]">
          <X aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}

/** Multiline input: Enter sends, Shift+Enter breaks the line, IME confirmations never send; files by button, drop (in Conversation) or paste. */
export function Composer({ convKey, label, placeholder, files, ready, closedReason, reply, onCancelReply, mentionCandidates }: Props) {
  const [text, setText] = useState("");
  // Mentions picked in this draft: the text shows `@name`, the wire gets `<@id>` for the ones still intact (lib/mentions.ts).
  const [tokens, setTokens] = useState<MentionToken[]>([]);
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const nextCaret = useRef<number | null>(null);
  const pickerId = useId();
  const counterId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const wire = toWire(text.trim(), tokens); // what is sent: its length is what the 2000 limit counts
  const length = wire.length;
  const over = length > MAX_MESSAGE_LENGTH;
  const disabled = !ready || closedReason !== null;
  const canSend = sendAllowed({ disabled, over, textLength: length, files: files.items.map((i) => i.state) });

  useEffect(() => {
    if (reply) box.current?.focus();
  }, [reply?.id]);

  // "Sửa lại" on a message AutoMod blocked: its text comes back here (after what is typed already), mentions as `@name`
  const reclaimed = useStore(chat.store, (s) => s.convs[convKey]?.reclaimed ?? null);
  useEffect(() => {
    if (reclaimed === null) return;
    const back = toDraft(reclaimed, (id) => {
      const c = mentionCandidates?.find((m) => m.userId === id);
      return c && labelOf(c);
    });
    setText((now) => (now.trim() ? `${now}\n${back.text}` : back.text));
    setTokens((all) => [...all, ...back.tokens.filter((x) => !all.some((y) => y.label === x.label))]);
    chat.clearReclaimed(convKey);
    box.current?.focus();
  }, [reclaimed, convKey]);

  const typing = mentionCandidates && !disabled ? activeMention(text, caret) : null;
  const suggestions = useMemo(() => (typing && typing.start !== dismissedAt ? rankCandidates(mentionCandidates ?? [], typing.query) : []), [typing?.start, typing?.query, dismissedAt, mentionCandidates]);
  const pickerOpen = suggestions.length > 0;
  const activeIndex = Math.min(sel, suggestions.length - 1);
  useEffect(() => setSel(0), [typing?.start, typing?.query]);
  useEffect(() => {
    if (!typing) setDismissedAt(null); // a later `@` opens the list again
  }, [typing === null]);
  useLayoutEffect(() => {
    if (nextCaret.current === null) return;
    box.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = null;
  }, [text]);

  function pick(c: Candidate) {
    if (!typing) return;
    const token = tokenFor(c, tokens);
    const inserted = insertMention(text, typing.start, caret, token.label);
    setTokens((all) => (all.some((x) => x.label === token.label) ? all : [...all, token]));
    setText(inserted.text);
    setCaret(inserted.caret);
    nextCaret.current = inserted.caret;
  }

  /** Arrow keys, Enter / Tab and Esc drive the open list; true = the key was theirs. */
  function pickerKey(e: KeyboardEvent) {
    if (!pickerOpen || e.nativeEvent.isComposing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") setSel((activeIndex + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
    else if (e.key === "Enter" || e.key === "Tab") pick(suggestions[activeIndex]!);
    else if (e.key === "Escape") setDismissedAt(typing!.start);
    else return false;
    e.preventDefault();
    return true;
  }

  function send() {
    if (!canSend) return;
    typingSender.sent(convKey);
    chat.send(convKey, { content: wire, attachments: files.queue.take(), replyToId: reply?.id });
    onCancelReply();
    setText("");
    setTokens([]);
    files.clearNotices();
  }

  /** A GIF is an ordinary message whose text is its URL: it goes out at once, as a reply when one is pending. */
  function sendGif(gif: GifResult) {
    if (disabled) return;
    typingSender.sent(convKey);
    chat.send(convKey, { content: gif.url, attachments: [], replyToId: reply?.id });
    onCancelReply();
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
      {reply && <ReplyBar reply={reply} onCancel={onCancelReply} />}
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
        <GifPicker disabled={disabled} onPick={sendGif} onClosed={() => box.current?.focus()} />
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
        {pickerOpen && <MentionPicker id={pickerId} items={suggestions} active={activeIndex} onActive={setSel} onPick={pick} />}
        <textarea
          ref={box}
          aria-label={label}
          aria-describedby={counterId}
          aria-autocomplete={mentionCandidates ? "list" : undefined}
          aria-controls={pickerOpen ? pickerId : undefined}
          aria-activedescendant={pickerOpen ? `${pickerId}-${activeIndex}` : undefined}
          aria-invalid={over || undefined}
          placeholder={!ready ? t("composer.loading") : (closedReason ?? placeholder)}
          disabled={disabled}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            typingSender.draftChanged(convKey, e.target.value);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (pickerKey(e)) return;
            if (cancelsReply({ key: e.key, isComposing: e.nativeEvent.isComposing }, reply !== null)) {
              e.preventDefault();
              return onCancelReply();
            }
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
      <p aria-live="polite" className="sr-only">
        {pickerOpen ? t("mention.results", { count: String(suggestions.length) }) : ""}
      </p>
      <div className="mt-1 flex h-4 items-center justify-between gap-3 px-2">
        <TypingIndicator convKey={convKey} />
        <p id={counterId} aria-live="polite" className={`numeric ml-auto shrink-0 text-right text-caption ${over ? "font-semibold text-danger" : "text-ink-faint"}`}>
          {length >= COUNTER_FROM ? (over ? t("composer.over", { count: String(length - MAX_MESSAGE_LENGTH) }) : t("composer.remaining", { count: String(MAX_MESSAGE_LENGTH - length) })) : ""}
        </p>
      </div>
    </div>
  );
}
