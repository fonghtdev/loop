import { Gear, Hash, House, MagnifyingGlass, SpeakerHigh, UsersThree } from "@phosphor-icons/react";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n/t";
import { useStore } from "zustand";
import { queryClient, session } from "../lib/app";
import { profiles } from "../lib/profiles";
import { openDm } from "../lib/social-actions";
import { goHome, useNav } from "../lib/nav";
import { openChannel } from "../lib/channel-open";
import { errorMessage } from "../lib/errors";
import { flatten, searchGroups, type GroupKind, type Range } from "../lib/quick-switch";
import { buildItems, resolveRecents, type Item, type Target } from "../lib/quick-switch-items";
import { isToggleShortcut, listAction } from "../lib/quick-switch-keys";
import { readRecents, recentKeyOf } from "../lib/quick-switch-recents";
import { closeQuickSwitch, restoreFocus, toggleQuickSwitch, useQuickSwitch } from "../lib/quick-switch-state";
import { DMS_KEY, type Dm } from "../lib/social";
import { guildQuery, useDms, useFriends, useGuilds } from "../lib/queries";
import { toast } from "../lib/toast";
import { useUnreadCount } from "../lib/unread-hooks";
import { Avatar } from "./Avatar";
import { Badge } from "./Badge";
import { OrbitArt } from "./Illustrations";
import { navRow } from "./navRow";
import { openGuild } from "./ServerRail";
import { EmptyState } from "./States";
import { shortcutLabel } from "./QuickSwitchField";
import { Tooltip } from "./Tooltip";

/**
 * ponytail: the channels of every server come from one `GET /guilds/:id` per server (the first MAX_GUILDS of them),
 * fetched when the palette opens and shared with the rest of the app through the query cache. Ceiling: that many
 * requests per open (cached for 30 s) and servers beyond the first MAX_GUILDS are searchable by name only.
 * Upgrade = one server-side search endpoint.
 */
const MAX_GUILDS = 20;

/** The entry point in the column headers: an icon button with the shortcut in its tooltip. */
export function QuickSwitchButton() {
  return (
    <Tooltip label={t("quick.title")} kbd={shortcutLabel()}>
      <button
        type="button"
        aria-label={t("quick.title")}
        aria-keyshortcuts="Control+K Meta+K"
        onClick={toggleQuickSwitch}
        className="-mr-2 grid size-10 shrink-0 place-items-center rounded-control text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-3 hover:text-ink active:scale-[.98]"
      >
        <MagnifyingGlass aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

function go(target: Target) {
  switch (target.type) {
    case "guild":
      return openGuild(target.guildId);
    case "channel":
      return openChannel(target.channel);
    case "dm":
      return useNav.setState({ guildId: null, channelId: null, dmId: target.dmId, settings: null });
    case "friend":
      return void openDm(target.userId).catch((err) => toast.push(errorMessage(err), "error"));
    case "place":
      return target.place === "settings" ? useNav.setState({ settings: "user" }) : goHome();
  }
}

/** The one Cmd/Ctrl+K listener of the app, and the palette's dialog (its content exists only while open). */
export function QuickSwitcher() {
  const open = useQuickSwitch((s) => s.open);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isToggleShortcut(e)) return;
      e.preventDefault();
      toggleQuickSwitch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const d = dialog.current;
    if (open && !d?.open) d?.showModal();
    if (!open && d?.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      aria-label={t("quick.title")}
      onClose={() => (closeQuickSwitch(), restoreFocus())}
      onClick={(e) => e.target === e.currentTarget && closeQuickSwitch()}
      className="mx-auto mt-[10vh] mb-auto max-h-[min(560px,80vh)] w-[min(640px,calc(100vw-48px))] overflow-hidden glass rounded-glass p-0 text-ink open:flex open:flex-col"
    >
      {open && <Palette />}
    </dialog>
  );
}

const useDebounced = <V,>(value: V, ms: number) => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
};

function Palette() {
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const userId = session.useSession((s) => s.user?.id);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const guilds = useGuilds().data;
  const dms = useDms().data;
  const friends = useFriends().data?.friends;
  const ids = useMemo(() => guilds?.slice(0, MAX_GUILDS).map((g) => g.id) ?? [], [guilds]);
  const { channels, loading } = useQueries({
    queries: ids.map(guildQuery),
    combine: (rs) => ({ channels: Object.fromEntries(rs.map((r, i) => [ids[i], r.data?.channels])), loading: rs.some((r) => r.isPending) }),
  });
  const byId = useStore(profiles.store, (s) => s.byId);
  const items = useMemo(() => buildItems({ guilds: guilds ?? [], channels, dms: dms ?? [], friends: friends ?? [], profiles: byId, myId: userId }), [guilds, channels, dms, friends, byId, userId]);
  const recents = useMemo(() => {
    const here = recentKeyOf(useNav.getState(), queryClient.getQueryData<Dm[]>(DMS_KEY));
    return resolveRecents(readRecents(userId ?? "").filter((k) => k !== here), items);
  }, [userId, items]);

  const groups = useMemo(() => searchGroups(items, query, { recents }), [items, query, recents]);
  const rows = flatten(groups);
  const active = Math.max(0, rows.findIndex((r) => r.item.key === activeKey));
  const optionId = (i: number) => `${listId}-o${i}`;

  const count = useDebounced(rows.length, 300);

  useEffect(() => {
    if (active === 0) list.current?.scrollTo({ top: 0 });
    else document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (item: Item) => {
    closeQuickSwitch();
    go(item.target);
  };
  const labels: Record<GroupKind, string> = {
    recent: t("quick.group.recent"),
    server: t("quick.group.server"),
    channel: t("quick.group.channel"),
    dm: t("quick.group.dm"),
    friend: t("quick.group.friend"),
    place: t("quick.group.place"),
  };
  let index = -1;
  const empty = rows.length === 0;
  return (
    <>
      <div className="flex items-center gap-3 border-b border-hair px-4 transition-colors duration-(--duration-fast) focus-within:border-cosmic-300">
        <MagnifyingGlass aria-hidden="true" className="shrink-0 text-ink-muted" />
        <input
          autoFocus
          role="combobox"
          aria-expanded={!empty}
          aria-controls={`${listId}-list`}
          aria-activedescendant={empty ? undefined : optionId(active)}
          aria-autocomplete="list"
          aria-label={t("quick.title")}
          placeholder={t("quick.input")}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => (setQuery(e.target.value), setActiveKey(null))}
          onKeyDown={(e) => {
            const action = listAction(e.nativeEvent, active, rows.length);
            if (!action) return;
            e.preventDefault();
            if (action.type === "move") setActiveKey(rows[action.to].item.key);
            else choose(rows[active].item);
          }}
          className="h-14 min-w-0 flex-1 bg-transparent text-chat text-ink outline-none placeholder:text-ink-muted focus-visible:shadow-none"
        />
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-2">
        <div id={`${listId}-list`} role="listbox" aria-label={t("quick.list")} hidden={empty}>
          {groups.map((g) => (
            <div key={g.kind} role="group" aria-labelledby={`${listId}-${g.kind}`}>
              <div id={`${listId}-${g.kind}`} className="px-3 pt-2 pb-1 text-caption font-semibold text-ink-faint">
                {labels[g.kind]}
              </div>
              {g.rows.map((row) => {
                const i = ++index;
                return <Option key={row.item.key} id={optionId(i)} item={row.item} ranges={row.ranges} active={i === active} onHover={() => setActiveKey(row.item.key)} onPick={() => choose(row.item)} />;
              })}
            </div>
          ))}
        </div>
        {empty && query.trim() && (
          <EmptyState page art={<OrbitArt />} title={t("quick.emptyTitle", { query: query.trim() })} body={t("quick.emptyBody")} />
        )}
      </div>
      <footer className="flex items-center gap-4 border-t border-hair px-4 py-2.5 text-caption text-ink-muted">
        <Hint keys="↑↓" label={t("quick.hintMove")} />
        <Hint keys="↵" label={t("quick.hintOpen")} />
        <Hint keys="Esc" label={t("quick.hintClose")} />
        {loading && <span className="ml-auto truncate">{t("quick.loading")}</span>}
      </footer>
      <div role="status" aria-live="polite" className="sr-only">
        {count === 0 ? t("quick.none") : t("quick.count", { count: String(count) })}
      </div>
    </>
  );
}

const Hint = ({ keys, label }: { keys: string; label: string }) => (
  <span className="flex items-center gap-1.5 whitespace-nowrap">
    <kbd className="rounded-xs bg-surface-4 px-1.5 py-0.5 text-micro font-semibold text-ink-muted">{keys}</kbd>
    {label}
  </span>
);

function Option({ id, item, ranges, active, onHover, onPick }: { id: string; item: Item; ranges: Range[]; active: boolean; onHover: () => void; onPick: () => void }) {
  const unread = useUnreadCount(item.convKey ?? "");
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      // mousemove, not mouseenter: rows that slide under a still pointer while the keyboard scrolls must not steal the selection
      onMouseMove={(e) => (e.movementX || e.movementY) && !active && onHover()}
      onClick={onPick}
      className={`min-h-12 w-full cursor-pointer py-1.5 ${navRow(active, false, "gap-3 px-3")}`}
    >
      <Lead item={item} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          <Highlight text={item.name} ranges={ranges} />
        </span>
        <span className="block truncate text-caption text-ink-muted">{item.sub}</span>
      </span>
      {unread > 0 && <Badge count={unread} />}
      {active && (
        <kbd aria-hidden="true" className="rounded-xs bg-surface-4 px-1.5 py-0.5 text-micro font-semibold text-ink-muted">
          ↵
        </kbd>
      )}
    </div>
  );
}

const tile = "grid size-8 shrink-0 place-items-center rounded-control bg-surface-4 text-ink-muted";
function Lead({ item }: { item: Item }) {
  if (item.avatarId) return <Avatar id={item.avatarId} name={item.name} image={item.image} className={`size-8 text-xs ${item.kind === "server" ? "rounded-control" : "rounded-full"}`} />;
  const icon: ReactNode =
    item.kind === "channel" ? (
      item.voice ? <SpeakerHigh aria-hidden="true" /> : <Hash aria-hidden="true" />
    ) : item.key === "place:settings" ? (
      <Gear aria-hidden="true" />
    ) : item.key === "place:friends" ? (
      <UsersThree aria-hidden="true" />
    ) : (
      <House aria-hidden="true" />
    );
  return <span className={tile}>{icon}</span>;
}

/** The name with the matched letters emphasised: plain text nodes and spans of text, never markup from the data. */
export function Highlight({ text, ranges }: { text: string; ranges: Range[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(
      <span key={a} data-match className="font-bold text-cosmic-200 underline decoration-cosmic-400 underline-offset-[3px]">
        {text.slice(a, b)}
      </span>,
    );
    at = b;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}
