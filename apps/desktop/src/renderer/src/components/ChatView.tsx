import { Permission } from "@loop/shared";
import { ArrowDown, ArrowClockwise, Copy, Hash, PencilSimple, Prohibit, Trash, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { chat, realtime, session } from "../lib/app";
import { EMPTY_CONV, type ConvChat, type Message, type Pending } from "../lib/chat";
import { useCopy } from "../lib/clipboard";
import { useComposerFiles } from "../lib/composer-files";
import { channelKey, type ConvKey } from "../lib/conversation";
import { hasFiles } from "../lib/drop";
import { errorMessage } from "../lib/errors";
import { useGuild, usePermissions } from "../lib/queries";
import { linkify } from "../lib/text";
import { buildTimeline, fullTimestamp, timeOfDay } from "../lib/timeline";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { Composer, submitKey } from "./Composer";
import { Dialog, DialogActions, DialogError } from "./Dialog";
import { MessageAttachments } from "./MessageAttachments";
import { Spinner } from "./Spinner";
import { ColumnHeader, EmptyState, LoadError, Skeleton } from "./States";

const NEAR_BOTTOM_PX = 80;
const LOAD_OLDER_PX = 400;

/** The open text channel of a server. */
export function ChatView({ guildId, channelId }: { guildId: string; channelId: string }) {
  const channel = useGuild(guildId).data?.channels.find((c) => c.id === channelId);
  const perms = usePermissions(guildId, channelId);
  const name = channel?.name ?? "";
  return (
    <Conversation
      convKey={channelKey(channelId)}
      header={
        <>
          <Hash aria-hidden="true" className="shrink-0 text-ink-faint" />
          <h1 className="min-w-0 truncate">{name}</h1>
        </>
      }
      logLabel={t("chat.log", { name })}
      start={{ icon: <Hash size={24} />, title: t("chat.startTitle", { name }), body: t("chat.startBody") }}
      canManage={perms.can(Permission.MANAGE_MESSAGES)}
      composer={{
        label: t("composer.label", { name }),
        placeholder: t("composer.placeholder", { name }),
        ready: perms.ready,
        closedReason: perms.can(Permission.SEND_MESSAGES) ? null : t("composer.noPermission"),
      }}
    />
  );
}

type ConversationProps = {
  convKey: ConvKey;
  header: ReactNode;
  /** Accessible name of the message log. */
  logLabel: string;
  /** The "this is the beginning" block at the top of the history. */
  start: { icon: ReactNode; title: string; body: string };
  /** May delete other people's messages (a DM has no moderators). */
  canManage: boolean;
  composer: { label: string; placeholder: string; ready: boolean; closedReason: string | null };
};

/**
 * One conversation, a channel or a DM: header, message list, composer and the drop zone for files. Owns the
 * history load and the socket listening; everything else is the same for both kinds.
 */
export function Conversation({ convKey, header, logLabel, start, canManage, composer }: ConversationProps) {
  const state = useStore(chat.store, (s) => s.convs[convKey] ?? EMPTY_CONV);
  const files = useComposerFiles(convKey);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    void chat.loadLatest(convKey);
    realtime.setConversation(convKey);
    return () => {
      realtime.setConversation(null);
      chat.close(convKey);
    };
  }, [convKey]);

  // The overlay shows while a file drag is over the conversation; leaving to a child must not hide it.
  const over = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragging(true);
  };
  const leave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  };
  const drop = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragging(false);
    if (!composer.closedReason && composer.ready) files.add(Array.from(e.dataTransfer.files));
  };

  return (
    <div onDragEnter={over} onDragOver={over} onDragLeave={leave} onDrop={drop} className="relative flex min-h-0 flex-1 flex-col">
      <ColumnHeader>{header}</ColumnHeader>
      {state.unavailable ? (
        <div className="flex-1 p-6">
          <EmptyState icon={<Prohibit />} title={t("chat.unavailableTitle")} body={t("chat.unavailableBody")} />
        </div>
      ) : (
        <MessageList convKey={convKey} logLabel={logLabel} start={start} state={state} canManage={canManage} />
      )}
      <Composer key={convKey} convKey={convKey} files={files} label={composer.label} placeholder={composer.placeholder} ready={composer.ready && !state.unavailable} closedReason={composer.closedReason} />
      {dragging && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-panel border-2 border-dashed border-moss-300 bg-surface-2/90">
          <p className="flex items-center gap-2 font-display text-lg font-bold text-moss-300">
            <UploadSimple />
            {composer.closedReason ? composer.closedReason : t("attachment.drop")}
          </p>
        </div>
      )}
    </div>
  );
}

function MessageList({ convKey, logLabel, start, state, canManage }: { convKey: ConvKey; logLabel: string; start: ConversationProps["start"]; state: ConvChat; canManage: boolean }) {
  const myId = session.useSession((s) => s.user?.id);
  const { messages, pending } = state;
  const rows = useMemo(() => buildTimeline(messages), [messages]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // the user is at (or near) the bottom
  const snap = useRef({ first: "", last: "", pending: 0, height: 0, top: 0 });
  const [unseen, setUnseen] = useState(0);
  const [announce, setAnnounce] = useState("");
  const [toDelete, setToDelete] = useState<Message | null>(null);

  // Keep the view where the reader expects it after every change of the list (before paint, so nothing jumps).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const prev = snap.current;
    const first = messages[0]?.id ?? "";
    const last = messages[messages.length - 1]?.id ?? "";
    const prepended = prev.first !== "" && first !== prev.first && last === prev.last;
    if (prepended) {
      el.scrollTop = prev.top + (el.scrollHeight - prev.height); // older page above: same messages stay put
    } else if (last !== prev.last || pending.length > prev.pending) {
      const lastIndex = prev.last ? messages.findIndex((m) => m.id === prev.last) : -1;
      const added = lastIndex === -1 ? [] : messages.slice(lastIndex + 1).filter((m) => m.author.id !== myId);
      const ownSend = pending.length > prev.pending;
      if (pinned.current || ownSend || prev.last === "") {
        el.scrollTop = el.scrollHeight;
        pinned.current = true;
      } else if (added.length) {
        setUnseen((n) => n + added.length);
      }
      const newest = added[added.length - 1];
      if (newest && prev.last !== "") setAnnounce(t("chat.announce", { name: newest.author.username, content: newest.content.slice(0, 200) || t("chat.announceFiles") }));
    }
    snap.current = { first, last, pending: pending.length, height: el.scrollHeight, top: el.scrollTop };
  }, [messages, pending.length, myId]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (pinned.current) setUnseen(0);
    snap.current = { ...snap.current, height: el.scrollHeight, top: el.scrollTop };
    if (el.scrollTop < LOAD_OLDER_PX) void chat.loadOlder(convKey);
  };

  // A short first page does not fill the view, so no scroll event would ever ask for more.
  useEffect(() => {
    const el = scroller.current;
    if (el && state.status === "ready" && !state.reachedStart && el.scrollHeight <= el.clientHeight) void chat.loadOlder(convKey);
  }, [state.status, state.reachedStart, messages.length, convKey]);

  const jumpDown = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setUnseen(0);
  };

  const onDelete = useCallback((m: Message) => setToDelete(m), []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [overflow-anchor:none]">
        {state.status === "loading" && !messages.length && (
          <div className="p-4">
            <Skeleton rows={8} />
          </div>
        )}
        {state.status === "error" && (
          <div className="p-4">
            <LoadError message={t("chat.loadFailed")} onRetry={() => void chat.loadLatest(convKey)} />
          </div>
        )}
        {/* Log of the conversation; aria-live is off so loading history is not read out, new messages go to the status below. */}
        <div role="log" aria-live="off" aria-label={logLabel} aria-busy={state.loadingOlder} className="flex flex-col pt-4 pb-2">
          <HistoryEdge state={state} convKey={convKey} start={start} />
          {rows.map((r) => (
            <MessageRow
              key={r.message.id}
              message={r.message}
              grouped={r.grouped}
              day={r.day}
              convKey={convKey}
              mine={r.message.author.id === myId}
              canDelete={r.message.author.id === myId || canManage}
              onDelete={onDelete}
            />
          ))}
          {pending.map((p) => (
            <PendingRow key={p.tempId} pending={p} convKey={convKey} username={session.useSession.getState().user?.username ?? ""} userId={myId ?? ""} />
          ))}
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      {unseen > 0 && (
        <button
          type="button"
          onClick={jumpDown}
          className="absolute bottom-3 left-1/2 flex h-10 -translate-x-1/2 animate-rise items-center gap-2 rounded-full bg-moss-400 px-4 text-sm font-semibold text-on-moss shadow-raised hover:bg-moss-300"
        >
          <ArrowDown aria-hidden="true" />
          {t("chat.newMessages", { count: String(unseen) })}
        </button>
      )}
      <Dialog open={toDelete !== null} onClose={() => setToDelete(null)} title={t("chat.deleteTitle")}>
        {toDelete && <DeleteBody message={toDelete} convKey={convKey} onDone={() => setToDelete(null)} />}
      </Dialog>
    </div>
  );
}

function HistoryEdge({ state, convKey, start }: { state: ConvChat; convKey: ConvKey; start: ConversationProps["start"] }) {
  if (state.status !== "ready") return null;
  if (state.reachedStart)
    return (
      <div className="mx-4 mb-4 border-b border-line pb-4">
        <span aria-hidden="true" className="mb-3 grid size-12 place-items-center rounded-full bg-surface-3 text-moss-300">
          {start.icon}
        </span>
        <p className="font-display text-2xl font-bold break-words">{start.title}</p>
        <p className="mt-1 text-sm text-ink-muted">{start.body}</p>
      </div>
    );
  if (state.olderFailed)
    return (
      <div className="flex justify-center py-2">
        <Button variant="ghost" onClick={() => void chat.loadOlder(convKey)}>
          <ArrowClockwise aria-hidden="true" />
          {t("chat.olderFailed")}
        </Button>
      </div>
    );
  return (
    <div className="flex h-10 items-center justify-center" aria-hidden={!state.loadingOlder}>
      {state.loadingOlder && <Spinner className="size-5 text-ink-faint" />}
    </div>
  );
}

function MessageText({ content }: { content: string }) {
  return (
    <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere] select-text">
      {linkify(content).map((part, i) =>
        part.href ? (
          <a
            key={i}
            href={part.href}
            onClick={(e) => {
              e.preventDefault(); // never navigate the window: links open in the OS browser
              void window.loop.openExternal(part.href!);
            }}
            className="text-moss-300 underline underline-offset-2 hover:text-moss-200"
          >
            {part.text}
          </a>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </p>
  );
}

type RowProps = {
  message: Message;
  grouped: boolean;
  day?: string;
  convKey: ConvKey;
  mine: boolean;
  canDelete: boolean;
  onDelete: (m: Message) => void;
};

/** One message (memoized: with 1000+ loaded, only changed rows re-render). */
const MessageRow = memo(function MessageRow({ message, grouped, day, convKey, mine, canDelete, onDelete }: RowProps) {
  const [editing, setEditing] = useState(false);
  const { copied, copy } = useCopy();
  return (
    <>
      {day && (
        <div role="separator" aria-label={day} className="mx-4 my-3 flex items-center gap-3 text-xs font-semibold text-ink-faint">
          <span className="h-px flex-1 bg-line" />
          {day}
          <span className="h-px flex-1 bg-line" />
        </div>
      )}
      <article
        aria-label={t("chat.messageFrom", { name: message.author.username, time: fullTimestamp(message.createdAt) })}
        // same bottom padding grouped or not: when an older page makes this row "grouped", only space ABOVE its
        // text disappears, which the prepend compensation (scrollHeight delta) cancels exactly
        className={`group relative flex gap-3 px-4 hover:bg-surface-3/40 focus-within:bg-surface-3/40 ${grouped ? "py-0.5" : "mt-2 pt-1 pb-0.5"}`}
      >
        <div className="w-10 shrink-0">
          {grouped ? (
            <time dateTime={message.createdAt} title={fullTimestamp(message.createdAt)} className="block pt-1 text-right text-[11px] text-ink-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
              {timeOfDay(message.createdAt)}
            </time>
          ) : (
            <Avatar id={message.author.id} name={message.author.username} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {!grouped && (
            <p className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate font-semibold text-ink">{message.author.username}</span>
              <time dateTime={message.createdAt} title={fullTimestamp(message.createdAt)} className="shrink-0 text-xs text-ink-faint">
                {timeOfDay(message.createdAt)}
              </time>
            </p>
          )}
          {editing ? (
            <EditBox message={message} convKey={convKey} onDone={() => setEditing(false)} />
          ) : (
            <>
              {message.content && <MessageText content={message.content} />}
              <MessageAttachments attachments={message.attachments} />
              {message.editedAt && (
                <span title={fullTimestamp(message.editedAt)} className="text-xs text-ink-faint">
                  {t("chat.edited")}
                </span>
              )}
            </>
          )}
        </div>
        {!editing && (
          <div
            role="toolbar"
            aria-label={t("chat.actions")}
            className="absolute -top-3 right-4 flex rounded-control border border-line bg-surface-2 p-0.5 opacity-0 shadow-raised group-hover:opacity-100 group-focus-within:opacity-100"
          >
            {message.content && (
              <ActionButton label={copied ? t("common.copied") : t("chat.copy")} onClick={() => void copy(message.content)}>
                <Copy aria-hidden="true" />
              </ActionButton>
            )}
            {mine && (
              <ActionButton label={t("chat.edit")} onClick={() => setEditing(true)}>
                <PencilSimple aria-hidden="true" />
              </ActionButton>
            )}
            {canDelete && (
              <ActionButton label={t("chat.delete")} danger onClick={() => onDelete(message)}>
                <Trash aria-hidden="true" />
              </ActionButton>
            )}
          </div>
        )}
      </article>
    </>
  );
});

function ActionButton({ label, danger = false, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid size-10 place-items-center rounded-[10px] hover:bg-surface-4 ${danger ? "text-danger" : "text-ink-muted hover:text-ink"}`}
    >
      {children}
    </button>
  );
}

/** Inline edit: Enter saves, Shift+Enter breaks the line, Esc cancels. */
function EditBox({ message, convKey, onDone }: { message: Message; convKey: ConvKey; onDone: () => void }) {
  const [text, setText] = useState(message.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    const content = text.trim();
    if ((!content && !message.attachments.length) || busy) return; // text may be emptied only when files remain
    if (content === message.content) return onDone();
    setBusy(true);
    setError("");
    try {
      await chat.edit(convKey, message.id, content);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <textarea
        aria-label={t("chat.editLabel")}
        autoFocus
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            return onDone();
          }
          if (!submitKey(e)) return;
          e.preventDefault();
          void save();
        }}
        className="max-h-[40vh] min-h-10 w-full resize-none rounded-control border border-line-strong bg-surface-3 px-3 py-2 text-[15px] leading-6 text-ink [field-sizing:content]"
      />
      <p className="text-xs text-ink-muted">{busy ? t("chat.saving") : t("chat.editHint")}</p>
      {error && (
        <p role="alert" className="text-[13px] font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function PendingRow({ pending, convKey, username, userId }: { pending: Pending; convKey: ConvKey; username: string; userId: string }) {
  const failed = pending.status === "failed";
  return (
    <article aria-label={t(failed ? "chat.failed" : "chat.sending")} className="mt-2 flex gap-3 px-4 py-1">
      <Avatar id={userId} name={username} className="size-10 rounded-full text-sm opacity-70" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2">
          <span className="truncate font-semibold text-ink">{username}</span>
          <span className={`flex shrink-0 items-center gap-1 text-xs ${failed ? "font-semibold text-danger" : "text-ink-faint"}`}>
            {failed ? <WarningCircle aria-hidden="true" size={14} /> : <Spinner className="size-3" />}
            {t(failed ? "chat.failed" : "chat.sending")}
          </span>
        </p>
        <div className={failed ? "" : "opacity-70"}>
          {pending.content && <MessageText content={pending.content} />}
          <MessageAttachments attachments={pending.attachments.map((a) => ({ ...a, url: a.previewUrl }))} preview />
        </div>
        {failed && (
          <div className="mt-1 flex gap-1">
            <Button variant="ghost" onClick={() => void chat.retry(convKey, pending.tempId)} className="h-10 px-3 text-sm">
              <ArrowClockwise aria-hidden="true" />
              {t("chat.retry")}
            </Button>
            <Button variant="ghost" onClick={() => chat.discard(convKey, pending.tempId)} className="h-10 px-3 text-sm">
              <Trash aria-hidden="true" />
              {t("chat.discard")}
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}

function DeleteBody({ message, convKey, onDone }: { message: Message; convKey: ConvKey; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    setBusy(true);
    try {
      await chat.remove(convKey, message.id);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <>
      <p className="text-sm text-ink-muted">{t("chat.deleteBody")}</p>
      <blockquote className="max-h-40 overflow-y-auto rounded-control border border-line bg-surface-3 px-3.5 py-2.5 text-sm whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
        {message.content || message.attachments.map((a) => a.filename).join(", ")}
      </blockquote>
      <DialogError message={error} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone} autoFocus>
          {t("common.cancel")}
        </Button>
        <Button type="button" loading={busy} onClick={() => void remove()} className="bg-danger! text-on-moss hover:opacity-90">
          {t("chat.deleteSubmit")}
        </Button>
      </DialogActions>
    </>
  );
}
