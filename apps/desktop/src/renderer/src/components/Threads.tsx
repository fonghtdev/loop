import { Archive, ArrowCounterClockwise, ChatsCircle, PencilSimple, Trash, X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import { Permission, threadNameSchema } from "@loop/shared";
import { t } from "../i18n/t";
import { session, threadPanel, unread } from "../lib/app";
import { channelKey } from "../lib/conversation";
import { errorMessage } from "../lib/errors";
import type { Message } from "../lib/chat";
import { usePermissions } from "../lib/queries";
import { deleteThread, renameThread, setArchived, startThread } from "../lib/thread-actions";
import { suggestName, threadChip, threadRights, threadsKey, threadsPath, type Thread } from "../lib/threads";
import { mentionsOf, unreadOf } from "../lib/unread";
import { toast } from "../lib/toast";
import { Badge, UnreadDot } from "./Badge";
import { Button } from "./Button";
import { Conversation } from "./ChatView";
import { Dialog, DialogActions, DialogError } from "./Dialog";
import { MenuItem, RowMenu } from "./RowMenu";
import { Spinner } from "./Spinner";
import { LoadError } from "./States";
import { TextField } from "./TextField";
import { Tooltip } from "./Tooltip";

const nameError = (name: string) => (threadNameSchema.safeParse(name).success ? undefined : name.trim() ? t("thread.nameInvalid") : t("validation.required"));

/** A thread's name: to start one, or to rename it. The server's refusal shows in Vietnamese. */
function ThreadNameForm({ initial, submit, action, onDone }: { initial: string; submit: string; action: (name: string) => Promise<unknown>; onDone: () => void }) {
  const [name, setName] = useState(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (busy || nameError(name)) return;
    setBusy(true);
    setServerError("");
    try {
      await action(name.trim());
      onDone();
    } catch (err) {
      setServerError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <TextField label={t("thread.name")} hint={t("thread.nameHint")} autoFocus onFocus={(e) => e.currentTarget.select()} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} error={tried ? nameError(name) : undefined} />
      <DialogError message={serverError} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={busy}>
          {submit}
        </Button>
      </DialogActions>
    </form>
  );
}

/** "Tạo luồng" from a message: the dialog that names it (prefilled from the message's first line). */
export function StartThreadDialog({ channelId, message, onClose }: { channelId: string; message: Message | null; onClose: () => void }) {
  return (
    <Dialog open={message !== null} onClose={onClose} title={t("thread.startTitle")}>
      {message && <ThreadNameForm initial={suggestName(message.content, t("thread.defaultName"))} submit={t("thread.startSubmit")} action={(name) => startThread(channelId, message.id, name)} onDone={onClose} />}
    </Dialog>
  );
}

/** Under a starter message: "N trả lời, hoạt động lúc ..." and a click opens the thread beside the channel. */
export function ThreadChip({ thread }: { thread: Thread }) {
  const chip = threadChip(thread);
  return (
    <button
      type="button"
      onClick={() => threadPanel.open(thread)}
      className="mt-1 flex h-10 max-w-full items-center gap-2 rounded-control border border-line bg-surface-3 px-3 text-left text-small text-ink-muted hover:bg-surface-4 hover:text-ink active:scale-[.98]"
    >
      <ChatsCircle aria-hidden="true" className="shrink-0 text-moss-300" />
      <span className="min-w-0 truncate font-semibold text-ink">{thread.name}</span>
      <span className="numeric shrink-0">{t(chip.key, chip.vars)}</span>
      {thread.archived && <span className="shrink-0 text-caption text-ink-faint">{t("thread.archivedTag")}</span>}
    </button>
  );
}

/** The channel header's "Luồng" button: a popover with the channel's threads, active then archived, with their unread badges. */
export function ThreadsButton({ channelId }: { channelId: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <RowMenu id={`threads-${channelId}`} label={t("thread.list")} trigger={<ChatsCircle aria-hidden="true" />} width="w-[min(360px,90vw)]" onOpen={() => setOpened(true)}>
      {(close) => <ThreadList channelId={channelId} opened={opened} close={close} />}
    </RowMenu>
  );
}

const useThreads = (channelId: string, archived: boolean, enabled: boolean) =>
  useQuery({
    queryKey: threadsKey(channelId, archived),
    enabled,
    queryFn: () => session.client.request<{ threads: Thread[] }>("GET", threadsPath(channelId, archived)).then((r) => r.threads),
  });

function ThreadList({ channelId, opened, close }: { channelId: string; opened: boolean; close: () => void }) {
  const active = useThreads(channelId, false, opened);
  const archived = useThreads(channelId, true, opened);
  if (active.isPending || archived.isPending) return <div className="grid h-24 place-items-center"><Spinner className="size-5 text-ink-faint" /></div>;
  if (active.isError || archived.isError) return <LoadError message={t("thread.loadFailed")} onRetry={() => void Promise.all([active.refetch(), archived.refetch()])} />;
  const open = (thread: Thread) => {
    close();
    threadPanel.open(thread);
  };
  return (
    <div className="flex max-h-[60vh] flex-col overflow-y-auto">
      <h2 className="px-2.5 pt-1.5 pb-2 font-display text-[15px] font-bold">{t("thread.listTitle")}</h2>
      {active.data.length + archived.data.length === 0 ? (
        <div className="px-2.5 pb-3 text-sm text-ink-muted">
          <p className="font-medium text-ink">{t("thread.empty")}</p>
          <p className="mt-1">{t("thread.emptyHint")}</p>
        </div>
      ) : (
        <>
          <ThreadGroup label={t("thread.active")} threads={active.data} onOpen={open} />
          <ThreadGroup label={t("thread.archived")} threads={archived.data} onOpen={open} />
        </>
      )}
    </div>
  );
}

function ThreadGroup({ label, threads, onOpen }: { label: string; threads: Thread[]; onOpen: (t: Thread) => void }) {
  const counts = useStore(unread.store);
  if (!threads.length) return null;
  return (
    <section aria-label={label} className="pb-1">
      <h3 className="px-2.5 pt-2 pb-1 text-micro font-semibold tracking-wide text-ink-faint uppercase">{label}</h3>
      <ul className="flex flex-col gap-0.5">
        {threads.map((thread) => {
          const key = channelKey(thread.id);
          const mentions = mentionsOf(counts, key);
          const n = unreadOf(counts, key);
          const chip = threadChip(thread);
          return (
            <li key={thread.id}>
              <button
                type="button"
                data-nav-item
                onClick={() => onOpen(thread)}
                className={`flex min-h-12 w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left hover:bg-white/8 focus-visible:bg-cosmic-wash focus-visible:shadow-none focus-visible:outline-offset-[-2px] ${n ? "font-semibold text-ink" : "text-ink-muted"}`}
              >
                <ChatsCircle aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{thread.name}</span>
                  <span className="numeric block truncate text-caption font-normal text-ink-faint">{t(chip.key, chip.vars)}</span>
                </span>
                {mentions > 0 ? <Badge count={mentions} label="unread.mentions" /> : n > 0 && <UnreadDot />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The open thread beside its channel (in place of the member list): its own message list and composer, a header
 * with rename / archive / delete for whoever may, and close. Esc closes it (when nothing inside used the key);
 * focus goes to its heading on open and back to where it was on close.
 */
export function ThreadPanel({ guildId, thread }: { guildId: string; thread: Thread }) {
  const perms = usePermissions(guildId, thread.parentChannelId);
  const myId = session.useSession((s) => s.user?.id);
  const rights = threadRights(perms.bits, thread, myId);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => {
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus();
    };
  }, [thread.id]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing || (e.target as Element).closest("dialog,[popover]")) return;
    e.preventDefault();
    threadPanel.close();
  };
  const archive = () => void setArchived(thread.id, !thread.archived).catch((err) => toast.push(errorMessage(err), "error"));
  const closedReason = thread.archived ? t("thread.archivedComposer") : rights.post ? null : t("composer.noPermission");
  return (
    <section aria-label={t("thread.panel", { name: thread.name })} onKeyDown={onKeyDown} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Conversation
        slot="side"
        convKey={channelKey(thread.id)}
        header={
          <>
            <ChatsCircle aria-hidden="true" className="shrink-0 text-ink-faint" />
            <h2 ref={heading} tabIndex={-1} className="min-w-0 truncate focus-visible:outline-none">
              {thread.name}
            </h2>
            {thread.archived && <span className="shrink-0 rounded-xs bg-surface-4 px-1.5 text-caption font-semibold text-ink-muted">{t("thread.archivedTag")}</span>}
          </>
        }
        actions={
          <>
            {rights.manage && (
              <RowMenu id={`thread-menu-${thread.id}`} label={t("thread.menu")}>
                {(close) => (
                  <>
                    <MenuItem icon={<PencilSimple aria-hidden="true" />} label={t("thread.rename")} onClick={() => (close(), setDialog("rename"))} />
                    <MenuItem icon={thread.archived ? <ArrowCounterClockwise aria-hidden="true" /> : <Archive aria-hidden="true" />} label={thread.archived ? t("thread.unarchive") : t("thread.archive")} onClick={() => (close(), archive())} />
                    <MenuItem danger icon={<Trash aria-hidden="true" />} label={t("thread.delete")} onClick={() => (close(), setDialog("delete"))} />
                  </>
                )}
              </RowMenu>
            )}
            <Tooltip label={t("thread.close")} kbd="Esc">
              <button type="button" aria-label={t("thread.close")} onClick={() => threadPanel.close()} className="grid size-10 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink active:scale-[.98]">
                <X aria-hidden="true" />
              </button>
            </Tooltip>
          </>
        }
        logLabel={t("thread.log", { name: thread.name })}
        start={{ icon: <ChatsCircle size={24} />, title: t("thread.startHere", { name: thread.name }), body: t("thread.startHereBody"), emptyTitle: t("thread.startHere", { name: thread.name }), emptyBody: t("thread.startHereBody") }}
        canManage={perms.can(Permission.MANAGE_MESSAGES)}
        composer={{ label: t("thread.composer", { name: thread.name }), placeholder: t("thread.composer", { name: thread.name }), ready: perms.ready, closedReason }}
      />
      <Dialog open={dialog === "rename"} onClose={() => setDialog(null)} title={t("thread.renameTitle")}>
        <ThreadNameForm initial={thread.name} submit={t("thread.renameSubmit")} action={(name) => renameThread(thread.id, name)} onDone={() => setDialog(null)} />
      </Dialog>
      <Dialog open={dialog === "delete"} onClose={() => setDialog(null)} title={t("thread.deleteTitle")}>
        <DeleteThreadBody thread={thread} onDone={() => setDialog(null)} />
      </Dialog>
    </section>
  );
}

function DeleteThreadBody({ thread, onDone }: { thread: Thread; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    setBusy(true);
    try {
      await deleteThread(thread);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <>
      <p className="text-sm text-ink-muted">{t("thread.deleteBody", { name: thread.name })}</p>
      <DialogError message={error} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone} autoFocus>
          {t("common.cancel")}
        </Button>
        <Button type="button" loading={busy} onClick={() => void remove()} variant="danger">
          {t("thread.deleteSubmit")}
        </Button>
      </DialogActions>
    </>
  );
}
