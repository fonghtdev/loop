import { Crown, Plus, SpeakerHigh, X } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { admin, presence, profileApi, session, voice } from "../lib/app";
import { profiles } from "../lib/profiles";
import { bannerUrl } from "../lib/identity";
import { profileKey } from "../lib/profile-api";
import { errorMessage } from "../lib/errors";
import { canManageMember } from "../lib/admin";
import { moveOptions } from "../lib/move-members";
import { voiceModButtons } from "../lib/voice-mod";
import { arrowNav } from "../lib/focus";
import { useNav } from "../lib/nav";
import { useVoiceSnapshot } from "../lib/voice-hooks";
import { MAX_USER_VOLUME, useUserVolume } from "../lib/voice-volume";
import { useNameOf } from "../lib/identity-hooks";
import { useStatusOf } from "../lib/presence-hooks";
import { dotOfPref, statusLabel } from "../lib/presence";
import { useBlocks, useDms, useFriends, useGuild, useMembers, usePermissions, useRoles } from "../lib/queries";
import { acceptRequest, blockUser, dismissRequest, openDm, sendFriendRequest, unblockUser, unfriend } from "../lib/social-actions";
import { pairWith } from "../lib/social";
import { toast } from "../lib/toast";
import { cardActions, cardDate, cardIdentity, closeUserCard, filterRoles, modView, openUserCard, placeCard, relationOf, roleChips, roleColor, rolesView, stepIndex, userCard, type CardTarget } from "../lib/user-card";
import { Avatar } from "./Avatar";
import { ConfirmBody } from "./Confirm";
import { StatusDot } from "./StatusDot";
import { Dialog } from "./Dialog";
import { Tooltip } from "./Tooltip";
import type { Channel, Role } from "../lib/permissions";

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
  const nameOf = useNameOf();
  const confirmName = confirm ? nameOf(confirm.user.id, confirm.user.username) : "";

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
        aria-label={target ? t("userCard.label", { name: nameOf(target.userId, target.username) }) : undefined}
        tabIndex={-1}
        onToggle={(e) => (e as unknown as ToggleEvent).newState === "closed" && dismissed()}
        className="m-0 max-h-[calc(100vh-16px)] w-[min(300px,calc(100vw-16px))] [inset:auto] glass overflow-y-auto rounded-card p-4 text-ink outline-none"
      >
        {target && <Card key={`${target.guildId}:${target.userId}`} target={target} onConfirm={setConfirm} />}
      </div>
      <Dialog open={confirm?.kind === "block"} onClose={() => setConfirm(null)} title={t("friends.blockTitle", { name: confirmName })}>
        {confirm && <ConfirmBody body={t("friends.blockBody")} submit={t("friends.block")} onDone={() => setConfirm(null)} action={() => blockUser(confirm.user)} />}
      </Dialog>
      <Dialog open={confirm?.kind === "unfriend"} onClose={() => setConfirm(null)} title={t("friends.unfriendTitle", { name: confirmName })}>
        {confirm && <ConfirmBody body={t("friends.unfriendBody")} submit={t("friends.unfriend")} onDone={() => setConfirm(null)} action={() => unfriend(confirm.user.id)} />}
      </Dialog>
      <Dialog open={confirm?.kind === "kick"} onClose={() => setConfirm(null)} title={t("settingsMembers.kickTitle", { name: confirmName })}>
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
  const { standing, bitsIn } = usePermissions(guildId);
  const voiceNow = useVoiceSnapshot();
  const inRoomWithUs = useStore(voice.store, (s) => s.participants.some((p) => p.userId === userId && !p.isLocal));
  const friends = useFriends().data;
  const blocks = useBlocks().data;
  const dms = useDms().data;
  const statusOf = useStatusOf();
  const myPref = useStore(presence.store, (s) => s.mine);
  const stored = useStore(profiles.store, (s) => s.byId[userId]);
  // quiet on failure: the card keeps showing what it already has
  const fetched = useQuery({ queryKey: profileKey(userId), queryFn: () => profileApi.get(userId), retry: false }).data;
  const who = cardIdentity(username, stored, fetched);
  const banner = bannerUrl(userId, who.bannerHash);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState(false);

  const member = members?.find((m) => m.userId === userId);
  const isBot = member?.isBot ?? false;
  const person = { id: userId, username };
  const dm = pairWith(dms, userId);
  const actions = cardActions({ selfId, userId, isBot, relation: relationOf(userId, friends), blocked: !!blocks?.some((u) => u.id === userId), hasDm: !!dm });
  const status = userId === selfId ? dotOfPref(myPref) : statusOf(userId);
  const mod = guild && members && roles && standing && member ? modView({ guildId: guildId!, guildName: guild.guild.name, ownerId: guild.guild.ownerId, standing, roles, members, channels: guild.channels }, member) : null;
  const chips = guildId && member && roles ? roleChips(member.roleIds, roles, guildId) : [];
  const isOwner = !!guild && guild.guild.ownerId === userId;
  const view = rolesView({ chipCount: chips.length, mod });
  const move = guild ? moveOptions({ userId, channels: guild.channels, ...voiceNow, bitsOf: bitsIn }) : null;
  // server mute / deafen: the kick rule decides whom (the same `canManageMember` the server mirrors)
  const canActOn = !!(standing && member && roles && guild && canManageMember(standing, member, guild.guild.ownerId, roles, "kick"));
  const voiceMod = guild ? voiceModButtons({ userId, selfId, canActOn, channels: guild.channels, ...voiceNow, bitsOf: bitsIn }) : null;

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
      {banner && <img key={banner} src={banner} alt="" decoding="async" className="-mx-4 -mt-4 h-20 max-w-none object-cover" />}
      <div className="flex items-center gap-3">
        <Avatar id={userId} name={who.title} className="size-14 rounded-full text-lg" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="min-w-0 truncate font-display text-heading3 font-bold select-text">{who.title}</h2>
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
          <p className="flex items-center gap-1.5 text-caption text-ink-muted">
            <StatusDot status={status} size={10} labelled={false} />
            {statusLabel(status)}
          </p>
          {who.handle && <p className="truncate text-caption text-ink-faint select-text">{who.handle}</p>}
        </div>
      </div>
      {who.statusText && <p className="text-small break-words text-ink select-text">{who.statusText}</p>}
      {who.bio && (
        <Section title={t("userCard.about")}>
          <p className="text-small break-words whitespace-pre-wrap text-ink-muted select-text">{who.bio}</p>
        </Section>
      )}

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

      {inRoomWithUs && <UserVolume userId={userId} username={username} />}
      {userId === selfId && (
        <div className="border-t border-hair pt-3">
          <button type="button" onClick={() => (useNav.setState({ settings: "user" }), closeUserCard())} className={neutral}>
            {t("userCard.editProfile")}
          </button>
        </div>
      )}
      {(actions.message || actions.friend || actions.block || mod?.kick || move || voiceMod) && (
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
          {move && (
            <button type="button" aria-expanded={moving} aria-haspopup="menu" disabled={busy} onClick={() => setMoving((v) => !v)} className={neutral}>
              {t("voice.move.to")}
            </button>
          )}
          {voiceMod?.buttons.map((b) => (
            <button key={b.label} type="button" disabled={busy} onClick={() => void run(() => admin.setVoiceState(voiceMod.channel.id, userId, b.body))} className={neutral}>
              {t(b.label)}
            </button>
          ))}
          {mod?.kick && (
            <button type="button" disabled={busy} onClick={() => ask("kick")} className={danger}>
              {t("settingsMembers.kick")}
            </button>
          )}
        </div>
      )}
      {moving && move && <MovePicker channels={move.targets} busy={busy} onClose={() => setMoving(false)} onPick={(c) => void run(() => admin.moveMember(c.id, userId), true)} />}
    </div>
  );
}

/** How loud this person is for me in the voice room (their microphone only; a stream has its own slider): 0-200%, or muted for me. */
function UserVolume({ userId, username }: { userId: string; username: string }) {
  const { volume, muted } = useUserVolume(userId);
  const percent = muted ? 0 : Math.round(volume * 100);
  return (
    <div className="flex flex-col gap-2 border-t border-hair pt-3">
      <span className="text-sm font-medium">{t("voice.userVolume.title", { name: username })}</span>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={MAX_USER_VOLUME * 100}
          step={5}
          value={percent}
          aria-label={t("voice.userVolume.slider", { name: username })}
          aria-valuetext={t("voice.userVolume.percent", { percent: String(percent) })}
          onChange={(e) => voice.setUserVolume(userId, { muted: false, volume: Number(e.target.value) / 100 })}
          className="h-8 min-w-0 flex-1 accent-moss-400"
        />
        <span aria-hidden="true" className="w-10 shrink-0 text-right text-[13px] text-ink-muted tabular-nums">
          {percent}%
        </span>
      </div>
      <div className="flex gap-2">
        <button type="button" aria-pressed={muted} onClick={() => voice.setUserVolume(userId, { muted: !muted })} className={neutral}>
          {t(muted ? "voice.userVolume.unmute" : "voice.userVolume.mute")}
        </button>
        <button type="button" disabled={!muted && volume === 1} onClick={() => voice.setUserVolume(userId, { muted: false, volume: 1 })} className={neutral}>
          {t("voice.userVolume.reset")}
        </button>
      </div>
    </div>
  );
}

const RoleDot = ({ role }: { role: Role }) => <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: roleColor(role) }} />;

/** The voice channels one may move this person to: arrows + Enter or a click; Esc closes only the picker. */
function MovePicker({ channels, busy, onClose, onPick }: { channels: Channel[]; busy: boolean; onClose: () => void; onPick: (c: Channel) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => list.current?.querySelector<HTMLElement>("[data-nav-item]")?.focus(), []);
  return (
    <div
      ref={list}
      role="menu"
      aria-label={t("voice.move.pick")}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return arrowNav(e);
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      className="flex max-h-40 flex-col overflow-y-auto rounded-control bg-surface-3 p-1 shadow-lg"
    >
      {channels.map((c) => (
        <button key={c.id} type="button" role="menuitem" data-nav-item disabled={busy} onClick={() => onPick(c)} className="flex h-9 w-full items-center gap-2 rounded-sm px-2.5 text-left text-sm hover:bg-surface-4 focus-visible:bg-surface-4">
          <SpeakerHigh aria-hidden="true" className="shrink-0 text-ink-muted" />
          <span className="min-w-0 truncate">{c.name}</span>
        </button>
      ))}
    </div>
  );
}

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
