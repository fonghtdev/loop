import { Permission } from "@loop/shared";
import { ArrowBendUpLeft, ArrowDown, ArrowClockwise, ChatsCircle, Check, Copy, Hash, PencilSimple, PushPin, PushPinSlash, SmileyWink, Trash, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { chat, realtime, session, unread } from "../lib/app";
import { profiles } from "../lib/profiles";
import { displayNameOf } from "../lib/identity";
import { useDisplayName } from "../lib/identity-hooks";
import { EMPTY_CONV, type ConvChat, type Message, type Pending } from "../lib/chat";
import { useMentionName } from "../lib/mention-hooks";
import { mentionable, mentionsMe, readable, toDraft, toWire } from "../lib/mentions";
import { pinRights } from "../lib/pins";
import { shouldAnimateArrival } from "../lib/arrival";
import { useCopy } from "../lib/clipboard";
import { useComposerFiles } from "../lib/composer-files";
import { channelKey, parseKey, type ConvKey } from "../lib/conversation";
import type { Slot } from "../lib/realtime";
import { canStartThread } from "../lib/threads";
import { hasFiles } from "../lib/drop";
import { errorMessage } from "../lib/errors";
import { move, reducedNow } from "../lib/motion";
import { useNav } from "../lib/nav";
import { useGuild, useMembers, usePermissions, useRoles } from "../lib/queries";
import { nameColorOf } from "../lib/role-colors";
import { jumpToMessage, liveReplyTarget } from "../lib/reply";
import { isFindShortcut, pendingJump, type SearchScope } from "../lib/search";
import { toast } from "../lib/toast";
import { buildTimeline, fullTimestamp, timeOfDay } from "../lib/timeline";
import type { Candidate } from "../lib/mentions";
import { Avatar } from "./Avatar";
import { UserCardTrigger } from "./UserCard";
import { Button } from "./Button";
import { Composer, submitKey } from "./Composer";
import { PinsPanel } from "./PinsPanel";
import { SearchPanel } from "./SearchPanel";
import { Dialog, DialogActions, DialogError } from "./Dialog";
import { ChatArt, OrbitArt, TicketArt } from "./Illustrations";
import { EmojiPicker } from "./EmojiPicker";
import { MessageAttachments } from "./MessageAttachments";
import { MessageEmbeds } from "./MessageEmbeds";
import { MessageText } from "./MessageText";
import { ReactionBar } from "./ReactionBar";
import { ReplyQuote } from "./ReplyQuote";
import { RowMenu } from "./RowMenu";
import { Spinner } from "./Spinner";
import { ColumnHeader, EmptyState, LoadError, Skeleton } from "./States";
import { Tooltip } from "./Tooltip";
import { StartThreadDialog, ThreadChip, ThreadsButton } from "./Threads";

const NEAR_BOTTOM_PX = 80;
const LOAD_OLDER_PX = 400;

/** The one row (or two) that just arrived live slides and fades in; nothing else in the list ever animates. */
function arrive(list: HTMLElement, ids: string[]) {
  for (const id of ids) {
    const row = list.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
    if (!row) continue;
    row.dataset.arrived = "live";
    move(row, {
      opacity: [0, 1],
      y: [10, 0],
      duration: 220,
      ease: "outQuart",
      onComplete: () => {
        row.style.removeProperty("opacity");
        row.style.removeProperty("transform");
      },
    });
  }
}

/** The open text channel of a server. */
export function ChatView({ guildId, channelId }: { guildId: string; channelId: string }) {
  const channel = useGuild(guildId).data?.channels.find((c) => c.id === channelId);
  const perms = usePermissions(guildId, channelId);
  const members = useMembers(guildId).data;
  const roles = useRoles(guildId).data;
  const guild = useGuild(guildId).data?.guild;
  const myId = session.useSession((s) => s.user?.id);
  const candidates = useMemo(() => (guild && members && roles && myId ? mentionable({ userId: myId, guild, members, roles }, channel, myId) : []), [guild, members, roles, myId, channel]);
  const name = channel?.name ?? "";
  return (
    <Conversation
      convKey={channelKey(channelId)}
      actions={<ThreadsButton channelId={channelId} />}
      threads={{ channelId, canStart: perms.can(Permission.SEND_MESSAGES) }}
      header={
        <>
          <Hash aria-hidden="true" className="shrink-0 text-ink-faint" />
          <h1 className="min-w-0 truncate">{name}</h1>
          {channel?.topic && (
            <>
              <span aria-hidden="true" className="h-5 w-px shrink-0 bg-hair-strong" />
              <Tooltip label={channel.topic}>
                <p className="min-w-0 flex-1 truncate text-small font-normal text-ink-muted select-text">{channel.topic}</p>
              </Tooltip>
            </>
          )}
        </>
      }
      logLabel={t("chat.log", { name })}
      start={{ icon: <Hash size={24} />, title: t("chat.startTitle", { name }), body: t("chat.startBody"), emptyTitle: t("chat.emptyTitle", { name }), emptyBody: t("chat.emptyBody") }}
      canManage={perms.can(Permission.MANAGE_MESSAGES)}
      mentionCandidates={candidates}
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
  start: { icon: ReactNode; title: string; body: string; emptyTitle: string; emptyBody: string };
  /** May delete other people's messages (a DM has no moderators). */
  canManage: boolean;
  /** Members `@` can name (a channel); omitted in a DM. */
  mentionCandidates?: Candidate[];
  /** Buttons at the right end of the header, before the pins button. */
  actions?: ReactNode;
  composer: { label: string; placeholder: string; ready: boolean; closedReason: string | null };
  /** Shown between the header and the messages (a DM call's streams). */
  banner?: ReactNode;
  /** Where it is on screen: the main area (default) or the side panel of an open thread. */
  slot?: Slot;
  /** A channel whose messages can start threads (omitted in a DM and inside a thread). */
  threads?: { channelId: string; canStart: boolean };
};

/**
 * One conversation, a channel or a DM: header, message list, composer and the drop zone for files. Owns the
 * history load and the socket listening; everything else is the same for both kinds.
 */
export function Conversation({ convKey, header, logLabel, start, canManage, mentionCandidates, actions, composer, banner, slot = "main", threads }: ConversationProps) {
  const state = useStore(chat.store, (s) => s.convs[convKey] ?? EMPTY_CONV);
  const files = useComposerFiles(convKey);
  const [dragging, setDragging] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [threadFrom, setThreadFrom] = useState<Message | null>(null);
  const reply = liveReplyTarget(replyTo, state.messages);
  const canWrite = composer.ready && !composer.closedReason && !state.unavailable;
  const rights = pinRights(convKey, { canManage, canWrite });
  const guildId = useNav((s) => (parseKey(convKey).kind === "channel" ? s.guildId : null));
  const channels = useGuild(guildId).data?.channels;
  const root = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  // the side panel (an open thread) has no search box of its own: the channel's searches threads too
  const searchScope: SearchScope | null = slot === "side" ? null : guildId ? { kind: "guild", guildId } : parseKey(convKey).kind === "dm" ? { kind: "dm", dmId: parseKey(convKey).id } : null;
  const goto = (id: string) => !!root.current && jumpToMessage(root.current, id, !reducedNow());

  // A search result in another conversation: once that one has loaded, scroll to the message if it is in the loaded window.
  useEffect(() => {
    if (state.status !== "ready") return;
    const id = pendingJump.take(convKey);
    if (id && !goto(id)) toast.push(t("search.outside"));
  }, [state.status, convKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setReplyTo(null);
    void chat.loadLatest(convKey);
    realtime.setConversation(convKey, slot);
    return () => {
      realtime.setConversation(null, slot);
      chat.close(convKey);
    };
  }, [convKey, slot]);

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
    <div
      ref={root}
      onDragEnter={over}
      onDragOver={over}
      onDragLeave={leave}
      onDrop={drop}
      onKeyDown={(e) => {
        if (!searchScope || !isFindShortcut(e) || e.nativeEvent.isComposing) return;
        e.preventDefault();
        searchBox.current?.focus();
      }}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <ColumnHeader>
        {header}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {searchScope && <SearchPanel scope={searchScope} convKey={convKey} channelName={(id) => channels?.find((c) => c.id === id)?.name} inputRef={searchBox} onGoto={goto} />}
          {actions}
          <PinsPanel convKey={convKey} guildId={guildId} canUnpin={rights.unpin} onGoto={goto} />
        </span>
      </ColumnHeader>
      {banner}
      {state.unavailable ? (
        <div className="flex-1 p-6">
          <EmptyState art={<OrbitArt />} title={t("chat.unavailableTitle")} body={t("chat.unavailableBody")} />
        </div>
      ) : (
        <MessageList convKey={convKey} slot={slot} logLabel={logLabel} start={start} state={state} canManage={canManage} canWrite={canWrite} rights={rights} onReply={setReplyTo} canThread={!!threads?.canStart && canWrite} onStartThread={threads ? setThreadFrom : undefined} />
      )}
      <Composer key={convKey} convKey={convKey} files={files} label={composer.label} placeholder={composer.placeholder} ready={composer.ready && !state.unavailable} closedReason={composer.closedReason} reply={reply} onCancelReply={() => setReplyTo(null)} mentionCandidates={mentionCandidates} />
      {threads && <StartThreadDialog channelId={threads.channelId} message={threadFrom} onClose={() => setThreadFrom(null)} />}
      {dragging && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-2 z-10 grid animate-fade place-items-center rounded-panel border-2 border-dashed border-cosmic-300 bg-surface-2/92">
          <div className="flex max-w-[360px] flex-col items-center gap-2 text-center">
            <TicketArt className="h-[150px] w-[240px]" />
            <p className="flex items-center gap-2 font-display text-heading3 font-extrabold tracking-[-0.02em] text-cosmic-200">
              <UploadSimple />
              {composer.closedReason ? composer.closedReason : t("attachment.drop")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

type ListProps = { convKey: ConvKey; slot: Slot; logLabel: string; start: ConversationProps["start"]; state: ConvChat; canManage: boolean; canWrite: boolean; rights: ReturnType<typeof pinRights>; onReply: (m: Message) => void; canThread: boolean; onStartThread?: (m: Message) => void };

function MessageList({ convKey, slot, logLabel, start, state, canManage, canWrite, rights, onReply, canThread, onStartThread }: ListProps) {
  const myId = session.useSession((s) => s.user?.id);
  const { messages, pending } = state;
  const rows = useMemo(() => buildTimeline(messages), [messages]);
  const guildId = useNav((s) => (parseKey(convKey).kind === "channel" ? s.guildId : null));
  const colors = useNameColors(guildId);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // the user is at (or near) the bottom
  const log = useRef<HTMLDivElement>(null);
  const snap = useRef({ first: "", last: "", pending: 0, height: 0, top: 0 });
  const [unseen, setUnseen] = useState(0);
  const [announce, setAnnounce] = useState("");
  const [toDelete, setToDelete] = useState<Message | null>(null);
  const latest = useRef(state);
  latest.current = state;

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
      const inView = pinned.current || ownSend;
      const now = latest.current;
      const arrivals = added.filter((m) => now.live.includes(m.id)).map((m) => m.id);
      if (arrivals.length && shouldAnimateArrival({ live: true, nearViewport: inView, settled: now.status === "ready" && !now.loadingOlder, reducedMotion: reducedNow() })) arrive(el, arrivals.slice(-2));
      if (pinned.current || ownSend || prev.last === "") {
        el.scrollTop = el.scrollHeight;
        pinned.current = true;
      } else if (added.length) {
        setUnseen((n) => n + added.length);
      }
      const newest = added[added.length - 1];
      if (newest && prev.last !== "") setAnnounce(t("chat.announce", { name: displayNameOf(profiles.store.getState().byId, newest.author.id, newest.author.username), content: newest.content.slice(0, 200) || t("chat.announceFiles") }));
    }
    snap.current = { first, last, pending: pending.length, height: el.scrollHeight, top: el.scrollTop };
    unread.setPinned(pinned.current, slot);
    unread.observe(convKey, messages[messages.length - 1]);
  }, [messages, pending.length, myId, convKey, slot]);

  // This list is the conversation on screen: it is what "read" means (see lib/unread.ts).
  useEffect(() => {
    unread.open(convKey, slot);
    return () => unread.open(null, slot);
  }, [convKey, slot]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (pinned.current) setUnseen(0);
    unread.setPinned(pinned.current, slot);
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
    unread.setPinned(true, slot);
    setUnseen(0);
  };

  // The composer's reply bar (or a growing text box) changes the list's height, and content can grow inside it (a link
  // preview arriving with message:update): a reader at the bottom stays at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const watch = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    watch.observe(el);
    if (log.current) watch.observe(log.current);
    return () => watch.disconnect();
  }, []);

  const onDelete = useCallback((m: Message) => setToDelete(m), []);
  const onJump = useCallback((id: string) => {
    if (scroller.current) jumpToMessage(scroller.current, id, !reducedNow());
  }, []);
  const onReact = useCallback(
    (messageId: string, emoji: string) => void chat.react(convKey, messageId, emoji).catch((err) => toast.push(errorMessage(err), "error")),
    [convKey],
  );

  const onPin = useCallback(
    (messageId: string, pinned: boolean) => void chat.pin(convKey, messageId, pinned).catch((err) => toast.push(errorMessage(err), "error")),
    [convKey],
  );

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
        <div ref={log} role="log" aria-live="off" aria-label={logLabel} aria-busy={state.loadingOlder} className="flex flex-col pt-4 pb-2">
          <HistoryEdge state={state} convKey={convKey} start={start} />
          {rows.map((r) => (
            <MessageRow
              key={r.message.id}
              message={r.message}
              grouped={r.grouped}
              day={r.day}
              convKey={convKey}
              mine={r.message.author.id === myId}
              nameColor={colors.get(r.message.author.id)}
              canDelete={r.message.author.id === myId || canManage}
              onDelete={onDelete}
              canWrite={canWrite}
              onReply={onReply}
              onJump={onJump}
              onReact={onReact}
              canPin={rights.pin}
              canUnpin={rights.unpin}
              onPin={onPin}
              canThread={canThread}
              onStartThread={onStartThread}
            />
          ))}
          {pending.map((p) => (
            <PendingRow key={p.tempId} pending={p} convKey={convKey} guildId={guildId} username={session.useSession.getState().user?.username ?? ""} userId={myId ?? ""} />
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
          className="absolute bottom-3 left-1/2 flex h-10 -translate-x-1/2 animate-pop items-center gap-2 rounded-full bg-moss-900 pr-4 pl-3 text-small font-semibold text-moss-200 shadow-[inset_0_0_0_1px_rgb(180_208_140/.38),var(--shadow-e3),0_0_24px_-6px_var(--color-glow)] hover:brightness-125 active:scale-[.98]"
        >
          <ArrowDown aria-hidden="true" />
          <span className="numeric">{t("chat.newMessages", { count: String(unseen) })}</span>
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
  if (state.reachedStart && !state.messages.length && !state.pending.length) return <EmptyState page art={<ChatArt />} title={start.emptyTitle} body={start.emptyBody} />;
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

type RowProps = {
  message: Message;
  grouped: boolean;
  day?: string;
  convKey: ConvKey;
  mine: boolean;
  /** The author's top colored role in this guild (undefined: default text color). */
  nameColor?: string;
  canDelete: boolean;
  onDelete: (m: Message) => void;
  /** Writing is open here: answering and adding reactions are offered. */
  canWrite: boolean;
  onReply: (m: Message) => void;
  onJump: (id: string) => void;
  onReact: (messageId: string, emoji: string) => void;
  canPin: boolean;
  canUnpin: boolean;
  onPin: (messageId: string, pinned: boolean) => void;
  /** Starting threads is open here (a channel, with SEND): offered on messages that have none. */
  canThread: boolean;
  onStartThread?: (m: Message) => void;
};

/** userId -> name color for the guild on screen, from the members and roles the shell already holds (no request of its own). */
function useNameColors(guildId: string | null) {
  const members = useMembers(guildId).data;
  const roles = useRoles(guildId).data;
  return useMemo(() => {
    const map = new Map<string, string>();
    if (roles)
      for (const m of members ?? []) {
        const c = nameColorOf(m.roleIds, roles, guildId!);
        if (c) map.set(m.userId, c);
      }
    return map;
  }, [members, roles, guildId]);
}

/** One message (memoized: with 1000+ loaded, only changed rows re-render). Sizes come from the density variables (--m-*). */
const MessageRow = memo(function MessageRow({ message, grouped, day, convKey, mine, nameColor, canDelete, onDelete, canWrite, onReply, onJump, onReact, canPin, canUnpin, onPin, canThread, onStartThread }: RowProps) {
  const author = useDisplayName(message.author.id, message.author.username);
  const [editing, setEditing] = useState(false);
  const { copied, copy } = useCopy();
  const guildId = useNav((s) => (parseKey(convKey).kind === "channel" ? s.guildId : null));
  const myId = session.useSession((s) => s.user?.id);
  const mentionName = useMentionName(guildId);
  const toMe = !mine && mentionsMe(message, myId); // a left accent: this one is for me
  return (
    <>
      {day && (
        // sticky: the day stays under the header while its messages scroll (CSS only, no scroll listener)
        <div role="separator" aria-label={day} className="sticky top-0 z-10 flex items-center gap-3 bg-[linear-gradient(var(--color-surface-2)_66%,transparent)] px-4 pt-4 pb-2.5 text-caption font-semibold text-ink-faint">
          <span className="h-px flex-1 bg-hair-strong" />
          {day}
          <span className="h-px flex-1 bg-hair-strong" />
        </div>
      )}
      <article
        data-mid={message.id}
        data-mention={toMe ? "true" : undefined}
        aria-label={t("chat.messageFrom", { name: author, time: fullTimestamp(message.createdAt) })}
        // same bottom padding grouped or not: when an older page makes this row "grouped", only space ABOVE its
        // text disappears, which the prepend compensation (scrollHeight delta) cancels exactly
        className={`group relative grid grid-cols-[var(--m-av)_minmax(0,1fr)] gap-x-3 px-4 pt-(--m-py) pb-(--m-py) hover:bg-[linear-gradient(90deg,rgb(255_255_255/.03),rgb(255_255_255/.012))] focus-within:bg-[linear-gradient(90deg,rgb(255_255_255/.03),rgb(255_255_255/.012))] data-flash:bg-cosmic-wash ${toMe ? "bg-[rgb(180_208_140/.07)] shadow-[inset_3px_0_0_var(--color-moss-300)]" : ""} ${grouped ? "" : "mt-(--m-gs)"}`}
      >
        <div>
          {grouped ? (
            <time dateTime={message.createdAt} title={fullTimestamp(message.createdAt)} className="numeric block text-right text-micro leading-(--m-lh) text-ink-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
              {timeOfDay(message.createdAt)}
            </time>
          ) : (
            <UserCardTrigger user={message.author} guildId={guildId} decorative>
              <Avatar id={message.author.id} name={author} className="size-(--m-av) rounded-full text-[calc(var(--m-av)*.35)]" />
            </UserCardTrigger>
          )}
        </div>
        <div className="min-w-0">
          {toMe && <span className="sr-only">{t("mention.toYou")}</span>}
          {message.pinned && (
            <p className="flex items-center gap-1 text-caption font-semibold text-moss-300">
              <PushPin aria-hidden="true" size={14} weight="fill" />
              {t("pin.badge")}
            </p>
          )}
          {message.replyTo && <ReplyQuote reply={message.replyTo} onJump={onJump} />}
          {!grouped && (
            <p className="flex min-w-0 items-baseline gap-2 leading-5">
              <UserCardTrigger user={message.author} guildId={guildId} className="min-w-0 truncate font-semibold tracking-[-0.005em] text-ink hover:underline" style={{ color: nameColor }}>
                {author}
              </UserCardTrigger>
              <time dateTime={message.createdAt} title={fullTimestamp(message.createdAt)} className="numeric shrink-0 text-caption text-ink-faint">
                {timeOfDay(message.createdAt)}
              </time>
            </p>
          )}
          {editing ? (
            <EditBox message={message} convKey={convKey} guildId={guildId} onDone={() => setEditing(false)} />
          ) : (
            <>
              {message.content && <MessageText content={message.content} guildId={guildId} />}
              <MessageAttachments attachments={message.attachments} />
              <MessageEmbeds messageId={message.id} embeds={message.embeds} />
              {message.editedAt && (
                <span title={fullTimestamp(message.editedAt)} className="text-caption text-ink-faint">
                  {t("chat.edited")}
                </span>
              )}
              <ReactionBar message={message} canReact={canWrite} onReact={onReact} />
              {message.thread && <ThreadChip thread={message.thread} />}
            </>
          )}
        </div>
        {!editing && (
          <div
            role="toolbar"
            aria-label={t("chat.actions")}
            className="absolute -top-6 right-4 z-20 flex gap-0.5 rounded-card bg-raise p-1 opacity-0 shadow-e2 transition-opacity duration-(--duration-fast) group-focus-within:opacity-100 group-hover:opacity-100"
          >
            {canWrite && (
              <>
                <RowMenu id={`react-${message.id}`} label={t("reaction.add")} width="w-[340px]" trigger={<SmileyWink aria-hidden="true" />}>
                  {(close) => (
                    <EmojiPicker
                      onPick={(emoji) => {
                        close();
                        onReact(message.id, emoji);
                      }}
                    />
                  )}
                </RowMenu>
                <ActionButton label={t("chat.reply")} onClick={() => onReply(message)}>
                  <ArrowBendUpLeft aria-hidden="true" />
                </ActionButton>
              </>
            )}
            {onStartThread && canStartThread({ inThread: !onStartThread, hasThread: !!message.thread, canSend: canThread }) && (
              <ActionButton label={t("thread.start")} onClick={() => onStartThread(message)}>
                <ChatsCircle aria-hidden="true" />
              </ActionButton>
            )}
            {(message.pinned ? canUnpin : canPin) && (
              <ActionButton label={message.pinned ? t("pin.remove") : t("pin.add")} onClick={() => onPin(message.id, !message.pinned)}>
                {message.pinned ? <PushPinSlash aria-hidden="true" /> : <PushPin aria-hidden="true" />}
              </ActionButton>
            )}
            {mine && (
              <ActionButton label={t("chat.edit")} onClick={() => setEditing(true)}>
                <PencilSimple aria-hidden="true" />
              </ActionButton>
            )}
            {message.content && (
              <ActionButton label={copied ? t("common.copied") : t("chat.copy")} onClick={() => void copy(readable(message.content, mentionName))}>
                {copied ? <Check aria-hidden="true" className="text-moss-300" /> : <Copy aria-hidden="true" />}
              </ActionButton>
            )}
            {canDelete && (
              <ActionButton label={t("chat.delete")} danger onClick={() => onDelete(message)}>
                <Trash aria-hidden="true" />
              </ActionButton>
            )}
            <span aria-live="polite" className="sr-only">
              {copied ? t("common.copied") : ""}
            </span>
          </div>
        )}
      </article>
    </>
  );
});

/** A toolbar button: 40x40 hit area, its name is the aria-label and the tooltip repeats it. */
function ActionButton({ label, danger = false, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`grid size-10 place-items-center rounded-control transition-colors duration-(--duration-fast) active:scale-[.98] ${danger ? "text-danger hover:bg-danger-bg" : "text-ink-muted hover:bg-white/[.07] hover:text-ink"}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Inline edit: Enter saves, Shift+Enter breaks the line, Esc cancels. */
function EditBox({ message, convKey, guildId, onDone }: { message: Message; convKey: ConvKey; guildId: string | null; onDone: () => void }) {
  const mentionName = useMentionName(guildId);
  // known mentions are edited as `@name` and written back as `<@id>` (unknown ones stay raw); no picker while editing
  const [draft] = useState(() => toDraft(message.content, mentionName));
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    const content = toWire(text.trim(), draft.tokens);
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

function PendingRow({ pending, convKey, guildId, username, userId }: { pending: Pending; convKey: ConvKey; guildId: string | null; username: string; userId: string }) {
  const name = useDisplayName(userId, username);
  const failed = pending.status === "failed";
  const status = pending.blocked ? "chat.blocked" : failed ? "chat.failed" : "chat.sending";
  return (
    <article aria-label={t(status)} className="mt-(--m-gs) grid grid-cols-[var(--m-av)_minmax(0,1fr)] gap-x-3 px-4 py-(--m-py)">
      <Avatar id={userId} name={name} className="size-(--m-av) rounded-full text-[calc(var(--m-av)*.35)] opacity-55" />
      <div className="min-w-0">
        <p className="flex items-baseline gap-2 leading-5">
          <span className="truncate font-semibold text-ink">{name}</span>
          <span className={`flex shrink-0 items-center gap-1 text-caption ${failed ? "font-semibold text-danger" : "text-ink-faint"}`}>
            {failed ? <WarningCircle aria-hidden="true" size={14} /> : <Spinner className="size-3" />}
            {t(status)}
          </span>
        </p>
        <div className={`transition-opacity duration-(--duration-base) ${failed ? "" : "opacity-55"}`}>
          {pending.content && <MessageText content={pending.content} guildId={guildId} />}
          <MessageAttachments attachments={pending.attachments.map((a) => ({ ...a, url: a.previewUrl }))} preview />
        </div>
        {pending.blocked && (
          <p role="alert" className="mt-1 text-small text-danger">
            {t("chat.blockedHint")} {pending.attachments.length > 0 && t("chat.blockedFiles")}
          </p>
        )}
        {failed && (
          <div className="mt-1 flex gap-1">
            {pending.blocked ? (
              <Button variant="ghost" onClick={() => chat.reclaim(convKey, pending.tempId)} className="h-10 px-3 text-sm">
                <PencilSimple aria-hidden="true" />
                {t("chat.reclaim")}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => void chat.retry(convKey, pending.tempId)} className="h-10 px-3 text-sm">
                <ArrowClockwise aria-hidden="true" />
                {t("chat.retry")}
              </Button>
            )}
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
        <Button type="button" loading={busy} onClick={() => void remove()} variant="danger">
          {t("chat.deleteSubmit")}
        </Button>
      </DialogActions>
    </>
  );
}
