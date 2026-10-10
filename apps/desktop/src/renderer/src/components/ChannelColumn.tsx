import { Permission } from "@loop/shared";
import { CaretDown, Check, Copy, Hash, LinkSimple, Plus, SignOut as Leave, SpeakerHigh } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { t } from "../i18n/t";
import { queryClient, revalidateGuild, session } from "../lib/app";
import { useCopy } from "../lib/clipboard";
import { errorMessage } from "../lib/errors";
import { arrowNav } from "../lib/focus";
import { goHome, useNav } from "../lib/nav";
import type { Channel, Guild } from "../lib/permissions";
import { useGuild, usePermissions } from "../lib/queries";
import { channelNameError, normalizeChannelName } from "../lib/validation";
import { Button } from "./Button";
import { Dialog, DialogActions, DialogError } from "./Dialog";
import { ColumnHeader, LoadError, Skeleton } from "./States";
import { Spinner } from "./Spinner";
import { TextField } from "./TextField";

type DialogName = "invite" | "channel" | "leave" | null;

/** The selected server's column: name + menu, channel list. */
export function ChannelColumn({ guildId }: { guildId: string }) {
  const guild = useGuild(guildId);
  const perms = usePermissions(guildId);
  const channelId = useNav((s) => s.channelId);
  const [dialog, setDialog] = useState<DialogName>(null);
  const close = () => setDialog(null);
  const name = guild.data?.guild.name ?? "";

  return (
    <>
      <GuildMenu name={name} canInvite={perms.can(Permission.CREATE_INVITE)} canManage={perms.can(Permission.MANAGE_CHANNELS)} onPick={setDialog} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {guild.isPending && <Skeleton rows={6} />}
        {guild.isError && <LoadError message={errorMessage(guild.error)} onRetry={() => void guild.refetch()} />}
        {guild.data && (
          <ul aria-label={t("channels.list")} onKeyDown={arrowNav} className="flex flex-col gap-0.5">
            {guild.data.channels.map((c) => (
              <li key={c.id}>
                <ChannelItem channel={c} active={c.id === channelId} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <Dialog open={dialog === "invite"} onClose={close} title={t("invite.title", { name })}>
        <InviteBody guildId={guildId} onDone={close} />
      </Dialog>
      <Dialog open={dialog === "channel"} onClose={close} title={t("createChannel.title")}>
        <CreateChannelForm guildId={guildId} onDone={close} />
      </Dialog>
      <Dialog open={dialog === "leave"} onClose={close} title={t("leave.title", { name })}>
        <LeaveBody guildId={guildId} onDone={close} />
      </Dialog>
    </>
  );
}

function ChannelItem({ channel, active }: { channel: Channel; active: boolean }) {
  const voice = channel.type === "VOICE";
  return (
    <button
      type="button"
      data-nav-item
      disabled={voice}
      aria-current={active ? "page" : undefined}
      aria-label={voice ? t("channels.voiceLabel", { name: channel.name }) : undefined}
      onClick={() => useNav.setState({ channelId: channel.id })}
      className={`flex h-10 w-full items-center gap-2 rounded-control px-2.5 text-left text-[15px] transition-colors duration-(--duration-fast) ${
        active ? "bg-surface-4 font-semibold text-ink" : voice ? "cursor-not-allowed text-ink-faint" : "text-ink-muted hover:bg-surface-3 hover:text-ink"
      }`}
    >
      {voice ? <SpeakerHigh aria-hidden="true" className="shrink-0" /> : <Hash aria-hidden="true" className="shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{channel.name}</span>
      {voice && <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-xs text-ink-faint">{t("channels.soon")}</span>}
    </button>
  );
}

/** Server name as the menu button; the menu is a native popover (light dismiss, Esc) anchored under it. */
function GuildMenu({ name, canInvite, canManage, onPick }: { name: string; canInvite: boolean; canManage: boolean; onPick: (d: DialogName) => void }) {
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
        className="-mx-2 flex h-10 w-[calc(100%+16px)] items-center gap-2 rounded-control px-2 text-left font-display text-[15px] font-bold [anchor-name:--guild-menu] hover:bg-surface-3"
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
        <MenuItem icon={<Leave aria-hidden="true" />} label={t("guildMenu.leave")} danger onClick={() => pick("leave")} />
      </div>
    </ColumnHeader>
  );
}

function MenuItem({ icon, label, danger = false, onClick }: { icon: ReactNode; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-nav-item
      onClick={onClick}
      className={`flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-sm font-medium hover:bg-surface-4 ${danger ? "text-danger" : "text-ink"}`}
    >
      {icon}
      {label}
    </button>
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

function CreateChannelForm({ guildId, onDone }: { guildId: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<Channel["type"]>("TEXT");
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
      const channel = await session.client.request<Channel>("POST", `/guilds/${guildId}/channels`, { name, type });
      queryClient.setQueryData<{ guild: Guild; channels: Channel[] }>(["guild", guildId], (old) =>
        old ? { ...old, channels: [...old.channels, { ...channel, overwrites: [] }] } : old,
      );
      revalidateGuild(guildId);
      if (type === "TEXT") useNav.setState({ channelId: channel.id });
      onDone();
    } catch (err) {
      setServerError(errorMessage(err));
      setBusy(false);
      if (err && (err as { status?: number }).status === 403) revalidateGuild(guildId);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
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
        <Button type="button" loading={busy} onClick={() => void leave()} className="bg-danger! text-on-moss hover:opacity-90">
          {t("leave.submit")}
        </Button>
      </DialogActions>
    </>
  );
}
