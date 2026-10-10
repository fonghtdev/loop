import { Compass, Plus, WarningCircle } from "@phosphor-icons/react";
import { useState, type FormEvent, type ReactNode } from "react";
import { t } from "../i18n/t";
import { queryClient, revalidateGuild, session } from "../lib/app";
import { errorMessage } from "../lib/errors";
import { arrowNav } from "../lib/focus";
import { goHome, useNav } from "../lib/nav";
import type { Channel, Guild } from "../lib/permissions";
import { useGuilds } from "../lib/queries";
import { guildNameError, parseInviteCode } from "../lib/validation";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { Dialog, DialogActions, DialogError } from "./Dialog";
import { LogoMark } from "./Logo";
import { Spinner } from "./Spinner";
import { TextField } from "./TextField";

/** Opening a server (again) also refetches its data: permissions or channels may have changed since. */
function openGuild(guildId: string) {
  revalidateGuild(guildId);
  if (useNav.getState().guildId !== guildId) useNav.setState({ guildId, channelId: null });
}

/** Server rail: home, one button per server (keyboard: Tab in, arrows between), create and join. */
export function ServerRail() {
  const guilds = useGuilds();
  const current = useNav((s) => s.guildId);
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);

  return (
    <nav aria-label={t("shell.servers")} onKeyDown={arrowNav} className="flex min-h-0 flex-col items-center bg-surface-0">
      <div className="flex w-full flex-1 flex-col items-center gap-2 overflow-y-auto py-3">
        <RailItem label={t("shell.home")} active={current === null} onClick={goHome}>
          <span className="grid size-12 place-items-center rounded-control bg-surface-3 text-moss-300">
            <LogoMark className="size-7" />
          </span>
        </RailItem>
        <div aria-hidden="true" className="h-px w-8 shrink-0 bg-line" />
        {guilds.isPending && <Spinner className="my-2 size-5 text-ink-faint" />}
        {guilds.isError && (
          <button type="button" onClick={() => void guilds.refetch()} title={t("rail.loadFailed")} aria-label={t("rail.loadFailed")} data-nav-item className="grid size-12 place-items-center rounded-control text-danger hover:bg-surface-3">
            <WarningCircle aria-hidden="true" />
          </button>
        )}
        {guilds.data?.map((g) => (
          <RailItem key={g.id} label={g.name} active={current === g.id} onClick={() => openGuild(g.id)}>
            <Avatar id={g.id} name={g.name} className="size-12 rounded-control text-base" />
          </RailItem>
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

function RailItem({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <div className="relative shrink-0">
      <span
        aria-hidden="true"
        className={`absolute top-1/2 -left-3 w-1 -translate-y-1/2 rounded-r-full bg-moss-300 transition-[height] duration-(--duration-base) ${active ? "h-8" : "h-0"}`}
      />
      <button
        type="button"
        data-nav-item
        aria-label={label}
        aria-current={active ? "page" : undefined}
        title={label}
        onClick={onClick}
        className={`block rounded-control transition-opacity duration-(--duration-fast) ${active ? "" : "opacity-80 hover:opacity-100"}`}
      >
        {children}
      </button>
    </div>
  );
}

function RailButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-nav-item
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-12 shrink-0 place-items-center rounded-control border border-dashed border-line-strong text-moss-300 transition-colors duration-(--duration-fast) hover:bg-surface-3"
    >
      {children}
    </button>
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

function CreateServerForm({ onDone }: { onDone: () => void }) {
  const f = useOneFieldForm(guildNameError, async (name) => {
    const { guild, channels } = await session.client.request<{ guild: Guild; channels: Channel[] }>("POST", "/guilds", { name: name.trim() });
    enterGuild(guild);
    useNav.setState({ guildId: guild.id, channelId: channels[0]?.id ?? null });
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

function JoinServerForm({ onDone }: { onDone: () => void }) {
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
