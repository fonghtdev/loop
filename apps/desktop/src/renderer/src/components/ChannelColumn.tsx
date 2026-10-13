import { Permission } from "@loop/shared";
import { ArrowDown, ArrowUp, CaretDown, Check, Copy, FolderSimple, FolderSimplePlus, Gear, Hash, LinkSimple, PencilSimple, Plus, ShieldCheck, SignOut as Leave, SpeakerHigh, Trash } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { settingsSections } from "../lib/admin";
import { admin, queryClient, revalidateGuild, session, voice } from "../lib/app";
import { ApiError } from "../lib/auth-client";
import { buildTree, canShift, groupIds, layoutOf, moveChannel, reduceGuild, shiftCategory, shiftChannel, shownChannels, type Category, type GuildData, type Tree } from "../lib/categories";
import { collapse, useCollapsed } from "../lib/category-collapse";
import { toast } from "../lib/toast";
import { useCopy } from "../lib/clipboard";
import { errorMessage } from "../lib/errors";
import { arrowNav } from "../lib/focus";
import { goHome, useNav } from "../lib/nav";
import type { Channel, Guild } from "../lib/permissions";
import { openChannel } from "../lib/channel-open";
import { channelKey } from "../lib/conversation";
import { useGuild, usePermissions } from "../lib/queries";
import { useUnreadCount } from "../lib/unread-hooks";
import { UnreadDot } from "./Badge";
import { useVoiceParticipants } from "../lib/voice-hooks";
import { channelNameError, normalizeChannelName } from "../lib/validation";
import { Button } from "./Button";
import { ConfirmBody } from "./Confirm";
import { navRow } from "./navRow";
import { MenuItem, RowMenu } from "./RowMenu";
import { Dialog, DialogActions, DialogError } from "./Dialog";
import { VoiceIndicators } from "./VoiceIndicators";
import { Avatar } from "./Avatar";
import { CategoryNameForm, MoveChannelBody } from "./CategoryForms";
import { ChannelCategory } from "./ChannelCategory";
import { QuickSwitchField } from "./QuickSwitchField";
import { ColumnHeader, LoadError, Skeleton } from "./States";
import { Spinner } from "./Spinner";
import { TextField } from "./TextField";
import { Tooltip } from "./Tooltip";

type DialogName = "invite" | "channel" | "category" | "leave" | null;

/** The selected server's column: name + menu, channel list. */
export function ChannelColumn({ guildId }: { guildId: string }) {
  const guild = useGuild(guildId);
  const perms = usePermissions(guildId);
  const channelId = useNav((s) => s.channelId);
  const settings = useNav((s) => s.settings);
  const collapsed = useCollapsed();
  const joinedVoiceId = useStore(voice.store, (s) => (s.target?.kind === "channel" && s.status !== "disconnected" ? s.target.id : null));
  const [dialog, setDialog] = useState<DialogName>(null);
  const [newType, setNewType] = useState<Channel["type"]>("TEXT");
  const [newIn, setNewIn] = useState<Category | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [moving, setMoving] = useState<Channel | null>(null);
  const [renaming, setRenaming] = useState<Category | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);
  const sections = settingsSections(perms.bits, perms.standing?.isOwner ?? false);
  const close = () => setDialog(null);
  const name = guild.data?.guild.name ?? "";
  const canManage = perms.can(Permission.MANAGE_CHANNELS);
  // the server menu's "Tạo kênh" makes an uncategorised channel; a category's + preselects that category
  const addChannel = (category: Category | null) => {
    setNewType("TEXT");
    setNewIn(category);
    setDialog("channel");
  };
  const tree = guild.data && buildTree(guild.data.channels, guild.data.categories);
  const keep = (c: Channel) => c.id === channelId || c.id === joinedVoiceId; // a folded category still shows the open channel and the voice room we are in

  async function saveLayout(next: Tree) {
    try {
      await admin.setLayout(guildId, layoutOf(next)); // refetches the guild afterwards, success or not
    } catch (err) {
      toast.push(err instanceof ApiError && err.status === 409 ? t("channels.layoutConflict") : errorMessage(err), "error");
    }
  }
  const row = (c: Channel, siblings: Channel[]) => (
    <ChannelRow
      key={c.id}
      channel={c}
      active={c.id === channelId && !settings}
      canManage={canManage}
      canPermissions={perms.can(Permission.MANAGE_ROLES)}
      onUp={tree && canShift(siblings, c.id, -1) ? () => void saveLayout(shiftChannel(tree, c.id, -1)) : undefined}
      onDown={tree && canShift(siblings, c.id, 1) ? () => void saveLayout(shiftChannel(tree, c.id, 1)) : undefined}
      onMove={() => setMoving(c)}
      onDelete={() => setDeleting(c)}
    />
  );

  return (
    <>
      <GuildMenu
        name={name}
        canInvite={perms.can(Permission.CREATE_INVITE)}
        canManage={canManage}
        onPick={(d) => (d === "channel" ? addChannel(null) : setDialog(d))}
        onSettings={sections.length ? () => useNav.setState({ settings: sections[0] }) : undefined}
      />
      <QuickSwitchField />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {guild.isPending && <Skeleton rows={6} />}
        {guild.isError && <LoadError message={errorMessage(guild.error)} onRetry={() => void guild.refetch()} />}
        {tree && (
          <ul aria-label={t("channels.list")} onKeyDown={arrowNav} className="flex flex-col gap-0.5">
            {tree.loose.map((c) => row(c, tree.loose))}
            {tree.groups.map(({ category, channels }) => {
              const folded = collapsed.has(category.id);
              return (
                <Fragment key={category.id}>
                  <ChannelCategory
                    name={category.name}
                    collapsed={folded}
                    onToggle={() => collapse.toggle(category.id)}
                    addLabel={t("category.add", { name: category.name })}
                    onAdd={canManage ? () => addChannel(category) : undefined}
                    menu={
                      canManage && (
                        <RowMenu id={`cat-${category.id}`} label={t("category.menu", { name: category.name })} size="size-8" className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100">
                          {(closeMenu) => (
                            <>
                              {canShift(groupIds(tree), category.id, -1) && (
                                <MenuItem icon={<ArrowUp aria-hidden="true" />} label={t("category.moveUp")} onClick={() => { closeMenu(); void saveLayout(shiftCategory(tree, category.id, -1)); }} />
                              )}
                              {canShift(groupIds(tree), category.id, 1) && (
                                <MenuItem icon={<ArrowDown aria-hidden="true" />} label={t("category.moveDown")} onClick={() => { closeMenu(); void saveLayout(shiftCategory(tree, category.id, 1)); }} />
                              )}
                              <MenuItem icon={<PencilSimple aria-hidden="true" />} label={t("category.rename")} onClick={() => { closeMenu(); setRenaming(category); }} />
                              <MenuItem icon={<Trash aria-hidden="true" />} label={t("category.delete")} danger onClick={() => { closeMenu(); setDeletingCategory(category); }} />
                            </>
                          )}
                        </RowMenu>
                      )
                    }
                  />
                  {shownChannels(channels, folded, keep).map((c) => row(c, channels))}
                </Fragment>
              );
            })}
          </ul>
        )}
      </div>
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} title={t("channels.deleteTitle", { name: deleting?.name ?? "" })}>
        {deleting && (
          <ConfirmBody body={t("channels.deleteBody")} submit={t("channels.delete")} onDone={() => setDeleting(null)} action={() => admin.deleteChannel(guildId, deleting.id)} />
        )}
      </Dialog>
      <Dialog open={!!deletingCategory} onClose={() => setDeletingCategory(null)} title={t("category.deleteTitle", { name: deletingCategory?.name ?? "" })}>
        {deletingCategory && (
          <ConfirmBody body={t("category.deleteBody")} submit={t("category.delete")} onDone={() => setDeletingCategory(null)} action={() => admin.deleteCategory(guildId, deletingCategory.id)} />
        )}
      </Dialog>
      <Dialog open={!!renaming} onClose={() => setRenaming(null)} title={t("category.rename")}>
        {renaming && <CategoryNameForm initial={renaming.name} submit={t("category.save")} action={(n) => admin.renameCategory(guildId, renaming.id, n)} onDone={() => setRenaming(null)} />}
      </Dialog>
      <Dialog open={!!moving} onClose={() => setMoving(null)} title={t("channels.moveTitle", { name: moving?.name ?? "" })}>
        {moving && tree && (
          <MoveChannelBody
            categories={tree.groups.map((g) => g.category)}
            current={moving.categoryId}
            onPick={(categoryId) => {
              const next = moveChannel(tree, moving.id, categoryId);
              setMoving(null);
              if (categoryId !== moving.categoryId) void saveLayout(next);
            }}
          />
        )}
      </Dialog>
      <Dialog open={dialog === "invite"} onClose={close} title={t("invite.title", { name })}>
        <InviteBody guildId={guildId} onDone={close} />
      </Dialog>
      <Dialog open={dialog === "channel"} onClose={close} title={t("createChannel.title")}>
        <CreateChannelForm guildId={guildId} initialType={newType} category={newIn} onDone={close} />
      </Dialog>
      <Dialog open={dialog === "category"} onClose={close} title={t("category.createTitle")}>
        <CategoryNameForm submit={t("category.create")} action={(n) => admin.createCategory(guildId, n)} onDone={close} />
      </Dialog>
      <Dialog open={dialog === "leave"} onClose={close} title={t("leave.title", { name })}>
        <LeaveBody guildId={guildId} onDone={close} />
      </Dialog>
    </>
  );
}

/** One channel line: the channel, its menu (with MANAGE_CHANNELS) and, for a voice channel, who is in it. */
function ChannelRow({ channel: c, active, canManage, canPermissions, onUp, onDown, onMove, onDelete }: { channel: Channel; active: boolean; canManage: boolean; canPermissions: boolean; onUp?: () => void; onDown?: () => void; onMove: () => void; onDelete: () => void }) {
  return (
    <li>
      <div className="group flex items-center">
        <ChannelItem channel={c} active={active} />
        {canManage && (
          <RowMenu id={`ch-${c.id}`} label={t("channels.menu", { name: c.name })} className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100">
            {(close) => (
              <>
                {canPermissions && (
                  <MenuItem
                    icon={<ShieldCheck aria-hidden="true" />}
                    label={t("channels.permissions")}
                    onClick={() => {
                      close();
                      useNav.setState({ channelId: c.id, settings: "overwrites" });
                    }}
                  />
                )}
                <MenuItem icon={<FolderSimple aria-hidden="true" />} label={t("channels.move")} onClick={() => { close(); onMove(); }} />
                {onUp && <MenuItem icon={<ArrowUp aria-hidden="true" />} label={t("channels.moveUp")} onClick={() => { close(); onUp(); }} />}
                {onDown && <MenuItem icon={<ArrowDown aria-hidden="true" />} label={t("channels.moveDown")} onClick={() => { close(); onDown(); }} />}
                <MenuItem icon={<Trash aria-hidden="true" />} label={t("channels.delete")} danger onClick={() => { close(); onDelete(); }} />
              </>
            )}
          </RowMenu>
        )}
      </div>
      {c.type === "VOICE" && <VoiceMembers channel={c} />}
    </li>
  );
}

function ChannelItem({ channel, active }: { channel: Channel; active: boolean }) {
  const voiceChannel = channel.type === "VOICE";
  const unread = useUnreadCount(channelKey(channel.id)) > 0 && !active;
  const joined = useStore(voice.store, (s) => s.target?.kind === "channel" && s.target.id === channel.id && s.status !== "disconnected");
  // a voice channel is joined by the click (a user gesture, which the OS prompts for mic need); opened only once joined
  const open = () => openChannel(channel);
  return (
    <button
      type="button"
      data-nav-item
      data-unread={unread ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      aria-label={voiceChannel ? t("channels.voiceLabel", { name: channel.name }) : undefined}
      onClick={open}
      className={`h-10 flex-1 ${navRow(active, unread)}`}
    >
      {voiceChannel ? <SpeakerHigh aria-hidden="true" className={`shrink-0 ${joined ? "text-moss-300" : ""}`} /> : <Hash aria-hidden="true" className="shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{channel.name}</span>
      {unread && <UnreadDot />}
    </button>
  );
}

/** Who is in a voice channel, under its name: initials, name, a ring while speaking; their mic / deafen marks. */
function VoiceMembers({ channel }: { channel: Channel }) {
  const people = useVoiceParticipants(channel.id);
  if (people.length === 0) return null;
  return (
    <ul aria-label={t("channels.voiceMembers", { name: channel.name })} className="mt-0.5 mb-1 flex flex-col gap-0.5 pl-6">
      {people.map((p) => (
        <li key={p.userId} data-user={p.userId} data-speaking={p.speaking ? "true" : undefined} className="flex h-10 items-center gap-2 rounded-sm px-1.5 text-small text-ink-muted hover:bg-white/[.04] hover:text-ink">
          <Avatar id={p.userId} name={p.username} speaking={!!p.speaking} className="mx-1 size-6 rounded-full text-[10px]" />
          <Tooltip label={p.username}>
            <span className={`min-w-0 flex-1 truncate ${p.speaking ? "text-ink" : ""}`}>{p.username}</span>
          </Tooltip>
          {p.speaking && <span className="sr-only">{t("voice.speaking")}</span>}
          <VoiceIndicators p={p} />
        </li>
      ))}
    </ul>
  );
}

/** Server name as the menu button; the menu is a native popover (light dismiss, Esc) anchored under it. */
function GuildMenu({ name, canInvite, canManage, onPick, onSettings }: { name: string; canInvite: boolean; canManage: boolean; onPick: (d: DialogName) => void; onSettings?: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const pick = (d: DialogName) => {
    menu.current?.hidePopover();
    onPick(d);
  };
  return (
    <ColumnHeader>
      <button
        type="button"
        popoverTarget="guild-menu"
        aria-label={t("guildMenu.open", { name })}
        className="-ml-2 flex h-10 min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left font-display text-[15px] font-bold [anchor-name:--guild-menu] hover:bg-surface-3"
      >
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <CaretDown aria-hidden="true" className="shrink-0 text-ink-muted" />
      </button>
      <div
        ref={menu}
        id="guild-menu"
        popover="auto"
        onToggle={(e) => (e as unknown as ToggleEvent).newState === "open" && menu.current?.querySelector<HTMLElement>("[data-nav-item]")?.focus()}
        onKeyDown={arrowNav}
        className="m-0 w-56 glass rounded-control p-1.5 text-ink [position-anchor:--guild-menu] [inset:auto] [top:calc(anchor(bottom)+6px)] [left:anchor(left)]"
      >
        {canInvite && <MenuItem icon={<LinkSimple aria-hidden="true" />} label={t("guildMenu.invite")} onClick={() => pick("invite")} />}
        {canManage && <MenuItem icon={<Plus aria-hidden="true" />} label={t("guildMenu.createChannel")} onClick={() => pick("channel")} />}
        {canManage && <MenuItem icon={<FolderSimplePlus aria-hidden="true" />} label={t("guildMenu.createCategory")} onClick={() => pick("category")} />}
        {onSettings && (
          <MenuItem
            icon={<Gear aria-hidden="true" />}
            label={t("guildMenu.settings")}
            onClick={() => {
              menu.current?.hidePopover();
              onSettings();
            }}
          />
        )}
        <MenuItem icon={<Leave aria-hidden="true" />} label={t("guildMenu.leave")} danger onClick={() => pick("leave")} />
      </div>
    </ColumnHeader>
  );
}

/** One invite per opening (a query, so StrictMode's double mount does not create two). */
function InviteBody({ guildId, onDone }: { guildId: string; onDone: () => void }) {
  const invite = useQuery({
    queryKey: ["invite", guildId],
    queryFn: () => session.client.request<{ code: string }>("POST", `/guilds/${guildId}/invites`, {}),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const { copied, copy } = useCopy();
  return (
    <>
      <p className="text-sm text-ink-muted">{t("invite.body")}</p>
      {invite.isPending && (
        <p className="flex h-11 items-center gap-2 text-sm text-ink-muted">
          <Spinner className="size-4 text-moss-300" />
          {t("invite.creating")}
        </p>
      )}
      <DialogError message={invite.isError ? errorMessage(invite.error) : ""} />
      {invite.data && (
        <div className="flex items-center gap-2">
          <output aria-label={t("invite.code")} className="flex h-11 min-w-0 flex-1 items-center rounded-control border border-line-strong bg-surface-3 px-3.5 font-mono text-[15px] tracking-wide select-text">
            <span className="truncate">{invite.data.code}</span>
          </output>
          <Button type="button" onClick={() => void copy(invite.data.code)} className="w-36">
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? t("common.copied") : t("common.copy")}
          </Button>
        </div>
      )}
      <p aria-live="polite" className="sr-only">
        {copied ? t("common.copied") : ""}
      </p>
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.close")}
        </Button>
      </DialogActions>
    </>
  );
}

function CreateChannelForm({ guildId, initialType, category, onDone }: { guildId: string; initialType: Channel["type"]; category: Category | null; onDone: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState(initialType);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const error = tried ? channelNameError(name) : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (busy || channelNameError(name)) return;
    setBusy(true);
    setServerError("");
    try {
      const channel = await session.client.request<Channel>("POST", `/guilds/${guildId}/channels`, { name, type, ...(category && { categoryId: category.id }) });
      // by id: our own channel:created event may already have put it there
      queryClient.setQueryData<GuildData>(["guild", guildId], (old) => old && reduceGuild(old, { type: "channel:created", channel }));
      revalidateGuild(guildId);
      if (type === "TEXT") useNav.setState({ channelId: channel.id, settings: null });
      onDone();
    } catch (err) {
      setServerError(errorMessage(err));
      setBusy(false);
      if (err && (err as { status?: number }).status === 403) revalidateGuild(guildId);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {category && <p className="-mt-1 truncate text-sm text-ink-muted">{t("createChannel.inCategory", { name: category.name })}</p>}
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">{t("createChannel.type")}</legend>
        {(["TEXT", "VOICE"] as const).map((value) => (
          <label key={value} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-control border px-3.5 ${type === value ? "border-moss-300 bg-surface-3" : "border-line-strong hover:bg-surface-3"}`}>
            <input type="radio" name="type" value={value} checked={type === value} onChange={() => setType(value)} className="size-4 accent-moss-400" />
            {value === "TEXT" ? <Hash aria-hidden="true" /> : <SpeakerHigh aria-hidden="true" />}
            <span className="text-[15px]">{value === "TEXT" ? t("createChannel.text") : t("createChannel.voice")}</span>
          </label>
        ))}
      </fieldset>
      <TextField
        label={t("createChannel.name")}
        hint={t("createChannel.nameHint")}
        autoFocus
        spellCheck={false}
        maxLength={100}
        value={name}
        onChange={(e) => setName(normalizeChannelName(e.target.value))}
        error={error}
      />
      <DialogError message={serverError} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={busy}>
          {t("createChannel.submit")}
        </Button>
      </DialogActions>
    </form>
  );
}

function LeaveBody({ guildId, onDone }: { guildId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  async function leave() {
    setBusy(true);
    setServerError("");
    try {
      await session.client.request("DELETE", `/guilds/${guildId}/members/me`);
      queryClient.setQueryData<Guild[]>(["guilds"], (old) => old?.filter((g) => g.id !== guildId));
      queryClient.removeQueries({ queryKey: ["guild", guildId] });
      goHome();
      onDone();
    } catch (err) {
      setServerError(errorMessage(err)); // the owner gets the 409 explained: transfer ownership or delete the server
      setBusy(false);
    }
  }
  return (
    <>
      <p className="text-sm leading-relaxed text-ink-muted">{t("leave.body")}</p>
      <DialogError message={serverError} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone} autoFocus>
          {t("common.cancel")}
        </Button>
        <Button type="button" loading={busy} onClick={() => void leave()} variant="danger">
          {t("leave.submit")}
        </Button>
      </DialogActions>
    </>
  );
}
