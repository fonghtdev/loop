import { Crown, Plus, X } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { admin, session } from "../lib/app";
import { errorMessage } from "../lib/errors";
import { useNav } from "../lib/nav";
import { useBlocks, useDms, useFriends, useGuild, useIsOnline, useMembers, usePermissions, useRoles } from "../lib/queries";
import { acceptRequest, blockUser, dismissRequest, openDm, sendFriendRequest, unblockUser, unfriend } from "../lib/social-actions";
import { toast } from "../lib/toast";
import { cardActions, cardDate, closeUserCard, filterRoles, modView, openUserCard, placeCard, presenceOf, relationOf, roleChips, roleColor, rolesView, stepIndex, userCard, type CardTarget } from "../lib/user-card";
import { Avatar } from "./Avatar";
import { ConfirmBody } from "./Confirm";
import { Dialog } from "./Dialog";
import { Tooltip } from "./Tooltip";
import type { Role } from "../lib/permissions";

type Person = { id: string; username: string };

/**
 * A name or avatar that opens the user card on click. `guildId` = the server whose roles/dates the card shows (null in a
 * DM). `decorative`: a mouse-only duplicate of a name button next to it (an avatar), out of the tab order and the tree.
 * Extra props (a Tooltip's handlers) go to the button.
 */
export function UserCardTrigger({ user, guildId, decorative, children, className = "", ...rest }: { user: Person; guildId: string | null; decorative?: boolean } & Omit<ComponentProps<"button">, "type">) {
  return (
    <button
      {...rest}
      type="button"
      tabIndex={decorative ? -1 : rest.tabIndex}
      aria-hidden={decorative || undefined}
      aria-haspopup={decorative ? undefined : "dialog"}
      onClick={(e) => openUserCard({ userId: user.id, username: user.username, guildId, anchor: e.currentTarget })}
      className={`cursor-pointer text-left ${className}`}
    >
      {children}
    </button>
  );
}

type Confirm = { kind: "block" | "unfriend" | "kick"; user: Person; guildId: string | null };

/**
 * The one user card of the app (mounted once in the shell): a native `popover="auto"` (light dismiss, Esc) placed beside
 * the clicked element by `placeCard`, re-placed when its content changes size. Confirmations (block, unfriend, kick) are
 * dialogs OUTSIDE the popover, because clicking a modal would light-dismiss the card that hosts it.
 */
export function UserCardHost() {
  const target = useStore(userCard, (s) => s.target);
  const box = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !target) {
      if (el?.matches(":popover-open")) el.hidePopover();
      return;
    }
    const place = () => {
      const a = target.anchor.getBoundingClientRect();
      const pos = placeCard(a, { width: el.offsetWidth, height: el.offsetHeight }, { width: innerWidth, height: innerHeight });
      el.style.left = `${pos.left}px`;
      el.style.top = `${pos.top}px`;
    };
    if (!el.matches(":popover-open")) el.showPopover();
    place();
    el.focus({ preventScroll: true });
    const watch = new ResizeObserver(place);
    watch.observe(el);
    return () => watch.disconnect();
  }, [target]);

  // The popover was dismissed (outside click, Esc): sync the store and give the focus back to what opened the card.
  function dismissed() {
    const el = box.current;
    if (!el || el.matches(":popover-open")) return; // a newer card is already open
    const opener = userCard.getState().target?.anchor;
    closeUserCard();
    const lost = document.activeElement === document.body || el.contains(document.activeElement);
    if (opener?.isConnected && lost) opener.focus();
  }

  return (
    <>
      <div
        ref={box}
        popover="auto"
        role={target ? "dialog" : undefined}
        aria-label={target ? t("userCard.label", { name: target.username }) : undefined}
        tabIndex={-1}
        onToggle={(e) => (e as unknown as ToggleEvent).newState === "closed" && dismissed()}
        className="m-0 max-h-[calc(100vh-16px)] w-[min(300px,calc(100vw-16px))] [inset:auto] glass overflow-y-auto rounded-card p-4 text-ink outline-none"
      >
        {target && <Card key={`${target.guildId}:${target.userId}`} target={target} onConfirm={setConfirm} />}
      </div>
      <Dialog open={confirm?.kind === "block"} onClose={() => setConfirm(null)} title={t("friends.blockTitle", { name: confirm?.user.username ?? "" })}>
        {confirm && <ConfirmBody body={t("friends.blockBody")} submit={t("friends.block")} onDone={() => setConfirm(null)} action={() => blockUser(confirm.user)} />}
      </Dialog>
      <Dialog open={confirm?.kind === "unfriend"} onClose={() => setConfirm(null)} title={t("friends.unfriendTitle", { name: confirm?.user.username ?? "" })}>
        {confirm && <ConfirmBody body={t("friends.unfriendBody")} submit={t("friends.unfriend")} onDone={() => setConfirm(null)} action={() => unfriend(confirm.user.id)} />}
      </Dialog>
      <Dialog open={confirm?.kind === "kick"} onClose={() => setConfirm(null)} title={t("settingsMembers.kickTitle", { name: confirm?.user.username ?? "" })}>
        {confirm?.guildId && <ConfirmBody body={t("settingsMembers.kickBody")} submit={t("settingsMembers.kick")} onDone={() => setConfirm(null)} action={() => admin.kick(confirm.guildId!, confirm.user.id)} />}
      </Dialog>
    </>
  );
}

const button = "h-10 rounded-control px-3 text-sm font-medium transition-colors duration-(--duration-fast) disabled:cursor-not-allowed disabled:opacity-60 active:scale-[.98]";
const neutral = `${button} bg-surface-3 text-ink hover:bg-surface-4`;
const danger = `${button} bg-danger-bg text-danger hover:brightness-110`;

function Card({ target, onConfirm }: { target: CardTarget; onConfirm: (c: Confirm) => void }) {
  const { userId, username, guildId } = target;
  const selfId = session.useSession((s) => s.user?.id) ?? "";
  const members = useMembers(guildId).data;
  const roles = useRoles(guildId).data;
  const guild = useGuild(guildId).data;
  const { standing } = usePermissions(guildId);
  const friends = useFriends().data;
  const blocks = useBlocks().data;
  const dms = useDms().data;
  const isOnline = useIsOnline();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const member = members?.find((m) => m.userId === userId);
  const isBot = member?.isBot ?? false;
  const person = { id: userId, username };
  const dm = dms?.find((d) => d.user.id === userId);
  const actions = cardActions({ selfId, userId, isBot, relation: relationOf(userId, friends), blocked: !!blocks?.some((u) => u.id === userId), hasDm: !!dm });
  const flag = userId === selfId ? true : presenceOf(userId, friends, dms);
  const online = flag !== undefined && (userId === selfId || isOnline({ id: userId, online: flag }));
  const mod = guild && members && roles && standing && member ? modView({ guildId: guildId!, guildName: guild.guild.name, ownerId: guild.guild.ownerId, standing, roles, members, channels: guild.channels }, member) : null;
  const chips = guildId && member && roles ? roleChips(member.roleIds, roles, guildId) : [];
  const isOwner = !!guild && guild.guild.ownerId === userId;
  const view = rolesView({ isOwner, chipCount: chips.length, mod });

  // every server answer is final: failures go to the toast, the caches are refreshed by the call itself
  async function run(fn: () => Promise<unknown>, done = false) {
    setBusy(true);
    try {
      await fn();
      if (done) closeUserCard();
    } catch (e) {
      toast.push(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }
  const ask = (kind: Confirm["kind"]) => {
    onConfirm({ kind, user: person, guildId });
    closeUserCard();
  };
  const openExisting = () => {
    useNav.setState({ guildId: null, channelId: null, dmId: dm!.id, settings: null });
    closeUserCard();
  };
  const friendButton = {
    add: <button type="button" disabled={busy} onClick={() => void run(() => sendFriendRequest(username))} className={neutral}>{t("userCard.addFriend")}</button>,
    cancel: <button type="button" disabled={busy} onClick={() => void run(() => dismissRequest(userId))} className={neutral}>{t("friends.cancel")}</button>,
    accept: <button type="button" disabled={busy} onClick={() => void run(() => acceptRequest(person))} className={neutral}>{t("friends.accept")}</button>,
    unfriend: <button type="button" disabled={busy} onClick={() => ask("unfriend")} className={neutral}>{t("friends.unfriend")}</button>,
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Avatar id={userId} name={username} className="size-14 rounded-full text-lg" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="min-w-0 truncate font-display text-heading3 font-bold select-text">{username}</h2>
            {isOwner && (
              <Tooltip label={t("members.owner")}>
                <span className="shrink-0 text-warning">
                  <Crown aria-hidden="true" weight="fill" size={16} />
                  <span className="sr-only">{t("members.owner")}</span>
                </span>
              </Tooltip>
            )}
            {isBot && <span className="shrink-0 rounded-xs bg-surface-4 px-1.5 text-micro font-bold text-ink">{t("userCard.bot")}</span>}
          </div>
          {flag !== undefined && (
            <p className="flex items-center gap-1.5 text-caption text-ink-muted">
              <span aria-hidden="true" className={`size-2 rounded-full ${online ? "bg-presence-on" : "bg-line-strong"}`} />
              {online ? t("presence.online") : t("presence.offline")}
            </p>
          )}
        </div>
      </div>

      {member && guildId && (
        <>
          {view.show && (
            <Section title={t("userCard.roles")}>
              <ul className="flex flex-wrap gap-1">
                {chips.map((r) => (
                  <li key={r.id} className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-control bg-surface-3 pl-2 text-caption text-ink-muted">
                    <RoleDot role={r} />
                    <span className="min-w-0 truncate">{r.name}</span>
                    {mod?.removable.has(r.id) ? (
                      <button type="button" disabled={busy} aria-label={t("userCard.removeRole", { name: r.name })} onClick={() => void run(() => admin.unassignRole(guildId, userId, r.id))} className="grid size-8 shrink-0 place-items-center rounded-control hover:bg-surface-4 hover:text-ink">
                        <X aria-hidden="true" size={12} />
                      </button>
                    ) : (
                      <span className="pr-2" />
                    )}
                  </li>
                ))}
                {view.canAdd && (
                  <li>
                    <button type="button" aria-expanded={adding} aria-haspopup="listbox" aria-label={t("userCard.addRole")} onClick={() => setAdding((v) => !v)} className="grid size-8 place-items-center rounded-control bg-surface-3 text-ink-muted hover:bg-surface-4 hover:text-ink">
                      <Plus aria-hidden="true" size={14} />
                    </button>
                  </li>
                )}
              </ul>
              {adding && mod && (
                <RolePicker roles={mod.assignable} busy={busy} onClose={() => setAdding(false)} onPick={(r) => void run(() => admin.assignRole(guildId, userId, r.id))} />
              )}
            </Section>
          )}
          <dl className="grid gap-2 border-t border-hair pt-3">
            <DateRow label={t("userCard.joinedLoop")} iso={member.createdAt} />
            <DateRow label={t("userCard.joinedGuild")} iso={member.joinedAt} />
          </dl>
        </>
      )}

      {(actions.message || actions.friend || actions.block || mod?.kick) && (
        <div className="flex flex-wrap gap-2 border-t border-hair pt-3">
          {actions.message && (
            <button type="button" disabled={busy} onClick={() => (actions.message === "open" ? openExisting() : void run(() => openDm(userId), true))} className={neutral}>
              {t("friends.messageShort")}
            </button>
          )}
          {actions.friend && friendButton[actions.friend]}
          {actions.block === "block" && (
            <button type="button" disabled={busy} onClick={() => ask("block")} className={danger}>
              {t("friends.block")}
            </button>
          )}
          {actions.block === "unblock" && (
            <button type="button" disabled={busy} onClick={() => void run(() => unblockUser(userId))} className={neutral}>
              {t("friends.unblock")}
            </button>
          )}
          {mod?.kick && (
            <button type="button" disabled={busy} onClick={() => ask("kick")} className={danger}>
              {t("settingsMembers.kick")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const RoleDot = ({ role }: { role: Role }) => <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: roleColor(role) }} />;

/** Search box over a list of roles: type to filter, arrows + Enter or a click to pick; Esc closes only the picker. */
function RolePicker({ roles, busy, onClose, onPick }: { roles: Role[]; busy: boolean; onClose: () => void; onPick: (r: Role) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = filterRoles(roles, query);
  const current = Math.min(active, shown.length - 1);
  useEffect(() => input.current?.focus(), []);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(stepIndex(current, e.key === "ArrowDown" ? 1 : -1, shown.length));
    } else if (e.key === "Enter" && shown[current] && !busy) {
      e.preventDefault();
      onPick(shown[current]);
    }
  }

  return (
    <div className="mt-2 rounded-control bg-surface-3 p-1 shadow-lg">
      <input
        ref={input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded="true"
        aria-controls="role-picker-list"
        aria-activedescendant={current >= 0 ? `role-pick-${shown[current].id}` : undefined}
        placeholder={t("userCard.searchRole")}
        aria-label={t("userCard.searchRole")}
        className="h-9 w-full rounded-sm bg-surface-2 px-2.5 text-sm text-ink outline-none placeholder:text-ink-muted"
      />
      {shown.length === 0 ? (
        <p className="px-2.5 py-3 text-caption text-ink-muted">{t("userCard.noRolesLeft")}</p>
      ) : (
        <ul id="role-picker-list" role="listbox" className="mt-1 flex max-h-40 flex-col overflow-y-auto">
          {shown.map((r, i) => (
            <li key={r.id} id={`role-pick-${r.id}`} role="option" aria-selected={i === current}>
              <button type="button" tabIndex={-1} disabled={busy} onMouseEnter={() => setActive(i)} onClick={() => onPick(r)} className={`flex h-9 w-full items-center gap-2 truncate rounded-sm px-2.5 text-left text-sm ${i === current ? "bg-surface-4" : ""}`}>
                <RoleDot role={r} />
                <span className="min-w-0 truncate">{r.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-hair pt-3" aria-label={title}>
      <h3 className="mb-1.5 text-micro font-bold tracking-[.08em] text-ink-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function DateRow({ label, iso }: { label: string; iso: string }) {
  const text = cardDate(iso);
  return (
    text && (
      <div>
        <dt className="text-micro font-bold tracking-[.08em] text-ink-muted uppercase">{label}</dt>
        <dd className="numeric text-small text-ink">{text}</dd>
      </div>
    )
  );
}
