import { Compass, Plus, WarningCircle } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { t } from "../i18n/t";
import { queryClient, revalidateGuild, session } from "../lib/app";
import { errorMessage } from "../lib/errors";
import { arrowNav } from "../lib/focus";
import { move, spring } from "../lib/motion";
import { goHome, useNav } from "../lib/nav";
import type { Channel, Guild } from "../lib/permissions";
import { useGuilds } from "../lib/queries";
import { pillOffset } from "../lib/rail";
import { useDmTotal, useGuildMentions } from "../lib/unread-hooks";
import { guildNameError, parseInviteCode } from "../lib/validation";
import { guildIconUrl } from "../lib/identity";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { Dialog, DialogActions, DialogError } from "./Dialog";
import { LogoMark } from "./Logo";
import { Badge } from "./Badge";
import { Spinner } from "./Spinner";
import { TextField } from "./TextField";
import { Tooltip } from "./Tooltip";

/** Opening a server (again) also refetches its data: permissions or channels may have changed since. */
export function openGuild(guildId: string) {
  revalidateGuild(guildId);
  useNav.setState(useNav.getState().guildId === guildId ? { settings: null } : { guildId, channelId: null, dmId: null, settings: null });
}

/**
 * One pill, a child of the scrolling list (so scrolling carries it along), moves to the active item: a spring on
 * `transform` through lib/motion (an instant jump under reduced motion). The first placement and a list that
 * re-lays itself out (servers loading) snap; only a change of the active item travels.
 */
function useActivePill(list: RefObject<HTMLDivElement | null>, pill: RefObject<HTMLSpanElement | null>, watch: unknown[]) {
  const at = useRef<number | null>(null);
  const activeKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const item = list.current?.querySelector<HTMLElement>("[data-rail-active]");
    const el = pill.current;
    if (!el) return;
    if (!item) {
      el.style.opacity = "0";
      at.current = null;
      return;
    }
    const y = pillOffset(item.offsetTop, item.offsetHeight);
    const key = item.dataset.railActive ?? "";
    el.style.opacity = "1";
    if (at.current === null || key === activeKey.current || y === at.current) el.style.transform = `translateY(${y}px)`;
    else move(el, { y: [at.current, y], ease: spring({ bounce: 0.2, duration: 260 }) });
    at.current = y;
    activeKey.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, watch);
}

/** Server rail: home, one button per server (keyboard: Tab in, arrows between), create and join. */
export function ServerRail() {
  const guilds = useGuilds();
  const current = useNav((s) => s.guildId);
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);
  const homeUnread = useDmTotal();
  const list = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  useActivePill(list, pill, [current, guilds.data, guilds.isPending, guilds.isError]);

  return (
    <nav aria-label={t("shell.servers")} onKeyDown={arrowNav} className="grain flex min-h-0 flex-col items-center border-r border-hair bg-surface-0 [--grain-under:var(--background-image-rail)]">
      <div ref={list} className="relative flex w-full flex-1 flex-col items-center gap-2 overflow-y-auto py-3">
        <span
          ref={pill}
          data-rail-pill
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 z-10 h-8 w-1 rounded-r-full bg-[linear-gradient(180deg,var(--color-cosmic-200),var(--color-cosmic-400))] opacity-0 shadow-[0_0_14px_var(--color-cosmic-glow)] will-change-transform"
        />
        <RailItem id="home" label={t("shell.home")} active={current === null} onClick={goHome} unread={homeUnread}>
          <span className="grid size-12 place-items-center rounded-control bg-raise text-moss-300 shadow-e1">
            <LogoMark className="size-7" />
          </span>
        </RailItem>
        <div aria-hidden="true" className="h-px w-8 shrink-0 bg-line" />
        {guilds.isPending && <Spinner className="my-2 size-5 text-ink-faint" />}
        {guilds.isError && (
          <Tooltip side="right" label={t("rail.loadFailed")}>
            <button type="button" onClick={() => void guilds.refetch()} aria-label={t("rail.loadFailed")} data-nav-item className="grid size-12 place-items-center rounded-control text-danger hover:bg-surface-3">
              <WarningCircle aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        {guilds.data?.map((g) => (
          <GuildRailItem key={g.id} guild={g} active={current === g.id} />
        ))}
        <RailButton label={t("rail.createServer")} onClick={() => setDialog("create")}>
          <Plus aria-hidden="true" />
        </RailButton>
        <RailButton label={t("rail.joinServer")} onClick={() => setDialog("join")}>
          <Compass aria-hidden="true" />
        </RailButton>
      </div>
      <Dialog open={dialog === "create"} onClose={() => setDialog(null)} title={t("createServer.title")}>
        <CreateServerForm onDone={() => setDialog(null)} />
      </Dialog>
      <Dialog open={dialog === "join"} onClose={() => setDialog(null)} title={t("joinServer.title")}>
        <JoinServerForm onDone={() => setDialog(null)} />
      </Dialog>
    </nav>
  );
}

function GuildRailItem({ guild: g, active }: { guild: Guild; active: boolean }) {
  const mentions = useGuildMentions(g.id);
  return (
    <RailItem id={g.id} label={g.name} active={active} onClick={() => openGuild(g.id)} mentions={mentions}>
      <Avatar id={g.id} name={g.name} image={guildIconUrl(g.id, g.iconHash)} className="size-12 rounded-control text-base" />
    </RailItem>
  );
}

function RailItem({ id, label, active, onClick, unread = 0, mentions = 0, children }: { id: string; label: string; active: boolean; onClick: () => void; unread?: number; /** Mentions waiting in this server: a red badge with their count. */ mentions?: number; children: ReactNode }) {
  return (
    <div data-rail-active={active ? id : undefined} className="relative shrink-0">
      <Tooltip side="right" label={label}>
        <button
          type="button"
          data-nav-item
          aria-label={label}
          aria-current={active ? "page" : undefined}
          onClick={onClick}
          className={`block rounded-control transition-[translate,box-shadow] duration-(--duration-base) ease-(--ease-out-soft) hover:-translate-y-px active:scale-[.98] ${
            active ? "shadow-[0_0_0_2px_var(--color-surface-0),0_0_0_4px_rgb(169_182_246/.55),0_0_18px_-2px_var(--color-cosmic-glow)]" : "hover:shadow-e2"
          }`}
        >
          {children}
        </button>
      </Tooltip>
      {mentions > 0 ? <Badge count={mentions} label="unread.mentions" className="absolute -right-1 -bottom-1" /> : unread > 0 && <Badge count={unread} className="absolute -right-1 -bottom-1" />}
    </div>
  );
}

function RailButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip side="right" label={label}>
      <button
        type="button"
        data-nav-item
        aria-label={label}
        onClick={onClick}
        className="grid size-12 shrink-0 place-items-center rounded-control text-moss-300 shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-colors duration-(--duration-fast) hover:bg-moss-900 hover:shadow-[inset_0_0_0_1px_rgb(180_208_140/.4)] active:scale-[.98]"
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** A guild we just created or joined: into the list and open it. */
function enterGuild(guild: Guild) {
  queryClient.setQueryData<Guild[]>(["guilds"], (old) => (old?.some((g) => g.id === guild.id) ? old : [...(old ?? []), guild]));
  void queryClient.invalidateQueries({ queryKey: ["guilds"] });
  openGuild(guild.id);
}

/** Shared by both forms: one field, client validation, a server error banner, submit state. */
function useOneFieldForm(check: (v: string) => string | undefined, submit: (v: string) => Promise<void>) {
  const [value, setValue] = useState("");
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState("");
  const [busy, setBusy] = useState(false);
  const error = tried ? check(value) : undefined;
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (busy || check(value)) return;
    setBusy(true);
    setServerError("");
    try {
      await submit(value);
    } catch (err) {
      setServerError(errorMessage(err));
      setBusy(false);
    }
  }
  return { value, setValue, error, serverError, busy, onSubmit };
}

export function CreateServerForm({ onDone }: { onDone: () => void }) {
  const f = useOneFieldForm(guildNameError, async (name) => {
    const { guild, channels } = await session.client.request<{ guild: Guild; channels: Channel[] }>("POST", "/guilds", { name: name.trim() });
    enterGuild(guild);
    useNav.setState({ guildId: guild.id, channelId: channels[0]?.id ?? null, dmId: null, settings: null });
    onDone();
  });
  return (
    <form onSubmit={f.onSubmit} noValidate className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">{t("createServer.body")}</p>
      <TextField label={t("createServer.name")} autoFocus maxLength={100} value={f.value} onChange={(e) => f.setValue(e.target.value)} error={f.error} />
      <DialogError message={f.serverError} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={f.busy}>
          {t("createServer.submit")}
        </Button>
      </DialogActions>
    </form>
  );
}

export function JoinServerForm({ onDone }: { onDone: () => void }) {
  const f = useOneFieldForm(
    (v) => (v.trim() === "" ? t("validation.required") : parseInviteCode(v) ? undefined : t("validation.inviteCode")),
    async (raw) => {
      // Already a member: the server answers with the guild all the same, so we just open it.
      const { guild } = await session.client.request<{ guild: Guild }>("POST", `/invites/${encodeURIComponent(parseInviteCode(raw)!)}/join`);
      enterGuild(guild);
      onDone();
    },
  );
  return (
    <form onSubmit={f.onSubmit} noValidate className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">{t("joinServer.body")}</p>
      <TextField
        label={t("joinServer.code")}
        hint={t("joinServer.codeHint")}
        autoFocus
        spellCheck={false}
        autoCapitalize="none"
        maxLength={200}
        value={f.value}
        onChange={(e) => f.setValue(e.target.value)}
        error={f.error}
      />
      <DialogError message={f.serverError} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={f.busy}>
          {t("joinServer.submit")}
        </Button>
      </DialogActions>
    </form>
  );
}
