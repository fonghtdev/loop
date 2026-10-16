import { ChatCircle, Prohibit, UserMinus, UsersThree } from "@phosphor-icons/react";
import type { PresenceStatus } from "@loop/shared";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { Avatar, PresenceAvatar } from "../components/Avatar";
import { Banner } from "../components/Banner";
import { Checklist } from "../components/Checklist";
import { Button } from "../components/Button";
import { ConfirmBody } from "../components/Confirm";
import { Dialog } from "../components/Dialog";
import { OrbitArt, PeopleArt, TicketArt } from "../components/Illustrations";
import { MenuItem, RowMenu } from "../components/RowMenu";
import { ColumnHeader, EmptyState, LoadError, Skeleton } from "../components/States";
import { TextField } from "../components/TextField";
import { Tooltip } from "../components/Tooltip";
import { Welcome } from "../components/Welcome";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";
import { errorMessage } from "../lib/errors";
import { isFirstRun } from "../lib/firstrun";
import { useFirstRun } from "../lib/firstrun-hooks";
import { useDisplayName, useNameOf } from "../lib/identity-hooks";
import { useStatusOf } from "../lib/presence-hooks";
import { statusLabel } from "../lib/presence";
import { useBlocks, useFriends } from "../lib/queries";
import { acceptRequest, blockUser, dismissRequest, openDm, sendFriendRequest, unblockUser, unfriend } from "../lib/social-actions";
import { sortFriends, type Friend, type PublicUser } from "../lib/social";
import { nextTab } from "../lib/tabs";
import { useTabIndicator } from "../lib/tabs-hooks";
import { usernameError } from "../lib/validation";

type Tab = "all" | "pending" | "blocked";
const TABS: Tab[] = ["all", "pending", "blocked"];
const TAB_LABELS: Record<Tab, MessageKey> = { all: "friends.tabAll", pending: "friends.tabPending", blocked: "friends.tabBlocked" };

/** Home's main area when no DM is open: add a friend, and the friends / pending / blocked lists. */
export function FriendsScreen() {
  const friends = useFriends();
  const blocks = useBlocks();
  const [tab, setTab] = useState<Tab>("all");
  const tabs = useRef<Record<Tab, HTMLButtonElement | null>>({ all: null, pending: null, blocked: null });
  const tabList = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const counts: Record<Tab, number | null> = {
    all: friends.data?.friends.length ?? null,
    pending: friends.data ? friends.data.incoming.length + friends.data.outgoing.length : null,
    blocked: blocks.data?.length ?? null,
  };

  useTabIndicator(tabList, indicator, tab, Object.values(counts).join());

  // The tab pattern: arrows (and Home/End) move between tabs and select them; only the selected tab is in the Tab order.
  const onTabKey = (e: KeyboardEvent) => {
    const next = nextTab(TABS.length, TABS.indexOf(tab), e.key);
    if (next === -1) return;
    e.preventDefault();
    setTab(TABS[next]);
    tabs.current[TABS[next]]?.focus();
  };

  const firstRun = useFirstRun();
  const addInput = useRef<HTMLInputElement>(null);

  const incoming = friends.data?.incoming;
  const seen = useRef<Set<string> | null>(null);
  const [announce, setAnnounce] = useState("");
  const nameOf = useNameOf();
  useEffect(() => {
    if (!incoming) return;
    const fresh = seen.current ? incoming.find((u) => !seen.current!.has(u.id)) : undefined;
    seen.current = new Set(incoming.map((u) => u.id));
    if (fresh) setAnnounce(t("friends.announceRequest", { name: nameOf(fresh.id, fresh.username) }));
  }, [incoming]);

  return (
    <>
      <ColumnHeader>
        <UsersThree aria-hidden="true" className="shrink-0 text-ink-faint" />
        <h1 className="min-w-0 truncate">{t("home.friends")}</h1>
      </ColumnHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-6 py-5">
          {firstRun && isFirstRun(firstRun.counts) && <Welcome onAddFriend={() => addInput.current?.focus()} />}
          <Checklist />
          <AddFriendForm inputRef={addInput} />
          <div ref={tabList} role="tablist" aria-label={t("friends.tabs")} onKeyDown={onTabKey} className="relative flex gap-1 border-b border-hair">
            {TABS.map((id) => (
              <button
                key={id}
                ref={(el) => void (tabs.current[id] = el)}
                type="button"
                role="tab"
                id={`friends-tab-${id}`}
                aria-selected={tab === id}
                aria-controls="friends-panel"
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                className={`h-12 rounded-t-control px-4 text-ui font-semibold whitespace-nowrap transition-colors duration-(--duration-fast) ${tab === id ? "text-ink" : "text-ink-muted hover:bg-white/[.045] hover:text-ink"}`}
              >
                {t(TAB_LABELS[id])}
                {counts[id] !== null && (
                  <>
                    {" "}
                    <span className="numeric font-medium text-ink-faint">({counts[id]})</span>
                  </>
                )}
              </button>
            ))}
            <span
              ref={indicator}
              aria-hidden="true"
              data-tab-indicator
              style={{ transform: "translateX(0) scaleX(0)" }}
              className="pointer-events-none absolute bottom-[-1px] left-0 h-0.5 w-[100px] origin-left rounded-t-xs bg-cosmic shadow-[0_0_12px_var(--color-cosmic-glow)]"
            />
          </div>
          <div role="tabpanel" id="friends-panel" aria-labelledby={`friends-tab-${tab}`}>
            {tab === "all" && <FriendList />}
            {tab === "pending" && <PendingList />}
            {tab === "blocked" && <BlockedList />}
          </div>
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
    </>
  );
}

function AddFriendForm({ inputRef }: { inputRef: Ref<HTMLInputElement> }) {
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const [done, setDone] = useState("");
  const nameOf = useNameOf();
  const normalized = name.trim().toLowerCase();
  const error = serverError || (tried ? usernameError(normalized) : undefined);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    setDone("");
    setServerError("");
    if (busy || usernameError(normalized)) return;
    setBusy(true);
    try {
      const { status, user } = await sendFriendRequest(normalized);
      setDone(t(status === "ACCEPTED" ? "friends.nowFriends" : "friends.requestSent", { name: nameOf(user.id, user.username) }));
      setName("");
      setTried(false);
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label={t("friends.addTitle")} className="relative edge flex flex-col gap-2 rounded-card bg-raise p-4 shadow-e2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <TextField
            ref={inputRef}
            label={t("friends.addLabel")}
            hint={t("friends.addHint")}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            maxLength={32}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setServerError("");
            }}
            error={error}
          />
        </div>
        {/* aligned with the input (the label above it is 20px + 6px gap) */}
        <Button type="submit" loading={busy} className="mt-[26px] shrink-0">
          {t("friends.addSubmit")}
        </Button>
      </div>
      <p role="status" className="text-small font-medium text-moss-300 empty:hidden">
        {done}
      </p>
    </form>
  );
}

/** Runs a row action: one at a time, its failure shown above the list. */
function useRowAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function run(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, run };
}

function ListState({ query, empty }: { query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown }; empty: ReactNode }) {
  if (query.isPending) return <Skeleton rows={5} />;
  if (query.isError) return <LoadError message={errorMessage(query.error)} onRetry={() => void query.refetch()} />;
  return empty;
}

function Row({ user, status, subtitle, children }: { user: PublicUser; status?: PresenceStatus; subtitle?: string; children: ReactNode }) {
  const name = useDisplayName(user.id, user.username);
  return (
    <li className="relative flex min-h-16 items-center gap-3 rounded-card px-3 py-2 transition-colors duration-(--duration-fast) hover:bg-white/[.04] not-first:before:absolute not-first:before:top-0 not-first:before:right-3 not-first:before:left-16 not-first:before:h-px not-first:before:bg-hair hover:before:opacity-0 [&:hover+li]:before:opacity-0">
      {status ? (
        <PresenceAvatar id={user.id} name={name} status={status} ring={2} labelled={false} className="size-10 rounded-full text-sm" />
      ) : (
        <Avatar id={user.id} name={name} className="size-10 rounded-full text-sm" />
      )}
      <span className="min-w-0 flex-1">
        <Tooltip label={name}>
          <span className="block truncate text-chat font-semibold text-ink select-text">{name}</span>
        </Tooltip>
        {subtitle && <span className="block truncate text-caption text-ink-muted">{subtitle}</span>}
      </span>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </li>
  );
}

function FriendList() {
  const friends = useFriends();
  const blocks = useBlocks();
  const statusOf = useStatusOf();
  const [dialog, setDialog] = useState<{ kind: "unfriend" | "block"; user: Friend } | null>(null);
  const nameOf = useNameOf();
  const action = useRowAction();
  const sorted = useMemo(() => sortFriends(friends.data?.friends ?? [], new Set(blocks.data?.map((u) => u.id))), [friends.data, blocks.data]);

  return (
    <>
      {action.error && (
        <div role="alert" className="mb-3">
          <Banner tone="danger">{action.error}</Banner>
        </div>
      )}
      <ListState query={friends} empty={sorted.length === 0 && <EmptyState art={<PeopleArt />} title={t("friends.noneTitle")} body={t("friends.noneBody")} />} />
      {friends.data && sorted.length > 0 && (
        <ul aria-label={t("friends.list")} className="flex flex-col">
          {sorted.map((f) => (
            <Row key={f.id} user={f} status={statusOf(f.id)} subtitle={statusLabel(statusOf(f.id))}>
              <IconButton label={t("friends.message", { name: nameOf(f.id, f.username) })} onClick={() => void action.run(f.id, () => openDm(f.id))}>
                <ChatCircle aria-hidden="true" />
              </IconButton>
              <FriendMenu friend={f} onMessage={() => void action.run(f.id, () => openDm(f.id))} onPick={(kind) => setDialog({ kind, user: f })} />
            </Row>
          ))}
        </ul>
      )}
      <Dialog open={dialog?.kind === "unfriend"} onClose={() => setDialog(null)} title={t("friends.unfriendTitle", { name: dialog ? nameOf(dialog.user.id, dialog.user.username) : "" })}>
        {dialog && <ConfirmBody body={t("friends.unfriendBody")} submit={t("friends.unfriend")} onDone={() => setDialog(null)} action={() => unfriend(dialog.user.id)} />}
      </Dialog>
      <Dialog open={dialog?.kind === "block"} onClose={() => setDialog(null)} title={t("friends.blockTitle", { name: dialog ? nameOf(dialog.user.id, dialog.user.username) : "" })}>
        {dialog && <ConfirmBody body={t("friends.blockBody")} submit={t("friends.block")} onDone={() => setDialog(null)} action={() => blockUser(dialog.user)} />}
      </Dialog>
    </>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <button type="button" aria-label={label} onClick={onClick} className="relative edge grid size-10 place-items-center rounded-control bg-surface-1 text-ink-muted shadow-e1 transition-colors duration-(--duration-fast) hover:bg-surface-3 hover:text-ink active:scale-[.98]">
        {children}
      </button>
    </Tooltip>
  );
}

/** Per-friend actions in the shared glass popover menu. */
function FriendMenu({ friend, onMessage, onPick }: { friend: Friend; onMessage: () => void; onPick: (kind: "unfriend" | "block") => void }) {
  const name = useDisplayName(friend.id, friend.username);
  return (
    <RowMenu id={`friend-${friend.id}`} label={t("friends.options", { name })}>
      {(close) => {
        const pick = (fn: () => void) => () => {
          close();
          fn();
        };
        return (
          <>
            <MenuItem icon={<ChatCircle aria-hidden="true" />} label={t("friends.messageShort")} onClick={pick(onMessage)} />
            <MenuItem icon={<UserMinus aria-hidden="true" />} label={t("friends.unfriend")} danger onClick={pick(() => onPick("unfriend"))} />
            <MenuItem icon={<Prohibit aria-hidden="true" />} label={t("friends.block")} danger onClick={pick(() => onPick("block"))} />
          </>
        );
      }}
    </RowMenu>
  );
}

function PendingList() {
  const friends = useFriends();
  const action = useRowAction();
  const { incoming = [], outgoing = [] } = friends.data ?? {};
  return (
    <>
      {action.error && (
        <div role="alert" className="mb-3">
          <Banner tone="danger">{action.error}</Banner>
        </div>
      )}
      <ListState query={friends} empty={incoming.length + outgoing.length === 0 && <EmptyState art={<TicketArt />} title={t("friends.noPendingTitle")} body={t("friends.noPendingBody")} />} />
      {incoming.length > 0 && (
        <Section title={t("friends.incoming", { count: String(incoming.length) })}>
          {incoming.map((u) => (
            <Row key={u.id} user={u}>
              <Button loading={action.busy === u.id} onClick={() => void action.run(u.id, () => acceptRequest(u))} className="h-10 px-3 text-sm">
                {t("friends.accept")}
              </Button>
              <Button variant="ghost" disabled={action.busy === u.id} onClick={() => void action.run(u.id, () => dismissRequest(u.id))} className="px-3 text-sm">
                {t("friends.decline")}
              </Button>
            </Row>
          ))}
        </Section>
      )}
      {outgoing.length > 0 && (
        <Section title={t("friends.outgoing", { count: String(outgoing.length) })}>
          {outgoing.map((u) => (
            <Row key={u.id} user={u} subtitle={t("friends.awaiting")}>
              <Button variant="ghost" loading={action.busy === u.id} onClick={() => void action.run(u.id, () => dismissRequest(u.id))} className="px-3 text-sm">
                {t("friends.cancel")}
              </Button>
            </Row>
          ))}
        </Section>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <h2 className="mb-1 px-3 text-micro font-bold tracking-[.08em] text-ink-faint uppercase">{title}</h2>
      <ul className="flex flex-col">
        {children}
      </ul>
    </section>
  );
}

function BlockedList() {
  const blocks = useBlocks();
  const action = useRowAction();
  return (
    <>
      {action.error && (
        <div role="alert" className="mb-3">
          <Banner tone="danger">{action.error}</Banner>
        </div>
      )}
      <ListState query={blocks} empty={blocks.data?.length === 0 && <EmptyState art={<OrbitArt />} title={t("friends.noBlockedTitle")} body={t("friends.noBlockedBody")} />} />
      {!!blocks.data?.length && (
        <ul aria-label={t("friends.blockedList")} className="flex flex-col">
          {blocks.data.map((u) => (
            <Row key={u.id} user={u}>
              <Button variant="ghost" loading={action.busy === u.id} onClick={() => void action.run(u.id, () => unblockUser(u.id))} className="px-3 text-sm">
                {t("friends.unblock")}
              </Button>
            </Row>
          ))}
        </ul>
      )}
    </>
  );
}
