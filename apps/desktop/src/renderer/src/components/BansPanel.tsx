import type { BanDto } from "@loop/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "../i18n/t";
import type { SettingsCtx } from "../lib/admin";
import { admin } from "../lib/app";
import { errorMessage } from "../lib/errors";
import { avatarUrl } from "../lib/identity";
import { toast } from "../lib/toast";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { ConfirmBody } from "./Confirm";
import { Dialog } from "./Dialog";
import { LoadError, Skeleton } from "./States";
import { Tooltip } from "./Tooltip";

/** Key under ["guild", id] so every admin call's refetch (and `revalidateGuild`) refreshes it too. */
export const bansKey = (guildId: string) => ["guild", guildId, "bans"];
const day = (iso: string) => new Date(iso).toLocaleDateString("vi-VN");

/** Who is banned, why and by whom (moderators only: the tab needs BAN_MEMBERS); unban with a confirm. */
export function BansPanel({ ctx }: { ctx: SettingsCtx }) {
  const bans = useQuery({ queryKey: bansKey(ctx.guildId), queryFn: () => admin.listBans(ctx.guildId) });
  const [unbanning, setUnbanning] = useState<BanDto | null>(null);
  const nameOf = (b: BanDto) => b.user.displayName || b.user.username;

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <p className="text-sm text-ink-muted">{t("bans.intro")}</p>
      {bans.isError && <LoadError message={errorMessage(bans.error)} onRetry={() => void bans.refetch()} />}
      {bans.isPending && <Skeleton rows={3} />}
      {bans.data?.length === 0 && <p className="relative edge rounded-panel bg-raise p-4 text-sm text-ink-muted shadow-e2">{t("bans.empty")}</p>}
      {!!bans.data?.length && (
        <ul aria-label={t("bans.list")} className="relative edge flex flex-col gap-0.5 rounded-panel bg-raise p-2 shadow-e2">
          {bans.data.map((b) => (
            <li key={b.user.id} className="flex min-h-14 items-center gap-3 rounded-control px-3 py-1.5">
              <Avatar id={b.user.id} name={nameOf(b)} image={avatarUrl(b.user.id, b.user.avatarHash)} className="size-8 rounded-full text-xs" />
              <div className="min-w-0 flex-1">
                <Tooltip label={b.user.username}>
                  <p className="truncate text-ui font-medium select-text">{nameOf(b)}</p>
                </Tooltip>
                <p className="text-small break-words text-ink-muted [overflow-wrap:anywhere]">{b.reason ? t("bans.reason", { reason: b.reason }) : t("bans.noReason")}</p>
                <p className="text-caption text-ink-faint">{b.bannedBy ? t("bans.by", { name: b.bannedBy.username, date: day(b.createdAt) }) : t("bans.byUnknown", { date: day(b.createdAt) })}</p>
              </div>
              <Button type="button" variant="secondary" onClick={() => setUnbanning(b)} aria-label={t("bans.unbanLabel", { name: nameOf(b) })}>
                {t("bans.unban")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!unbanning} onClose={() => setUnbanning(null)} title={t("bans.unbanTitle", { name: unbanning ? nameOf(unbanning) : "" })}>
        {unbanning && (
          <ConfirmBody
            body={t("bans.unbanBody")}
            submit={t("bans.unban")}
            onDone={() => setUnbanning(null)}
            action={async () => {
              await admin.unban(ctx.guildId, unbanning.user.id);
              toast.push(t("bans.unbanned"));
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
