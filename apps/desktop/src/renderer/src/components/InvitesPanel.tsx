import type { InviteDto } from "@loop/shared";
import { Check, Copy } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "../i18n/t";
import type { SettingsCtx } from "../lib/admin";
import { admin } from "../lib/app";
import { useCopy } from "../lib/clipboard";
import { errorMessage } from "../lib/errors";
import { canRevokeInvite, inviteStatus, seesAllInvites } from "../lib/invites";
import { Button } from "./Button";
import { ConfirmBody } from "./Confirm";
import { Dialog } from "./Dialog";
import { LoadError, Skeleton } from "./States";
import { Tooltip } from "./Tooltip";

/** Under ["guild", id] so admin refetches (and `revalidateGuild`) include it. */
export const invitesKey = (guildId: string) => ["guild", guildId, "invites"];
const when = (iso: string) => new Date(iso).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });

/** Every invite (MANAGE_ROLES) or the caller's own (CREATE_INVITE): code, creator, uses, expiry; copy and revoke. */
export function InvitesPanel({ ctx }: { ctx: SettingsCtx }) {
  const invites = useQuery({ queryKey: invitesKey(ctx.guildId), queryFn: () => admin.listInvites(ctx.guildId) });
  const [revoking, setRevoking] = useState<InviteDto | null>(null);
  const now = Date.now();

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <p className="text-sm text-ink-muted">{t(seesAllInvites(ctx.standing) ? "invites.introAll" : "invites.introOwn")}</p>
      {invites.isError && <LoadError message={errorMessage(invites.error)} onRetry={() => void invites.refetch()} />}
      {invites.isPending && <Skeleton rows={3} />}
      {invites.data?.length === 0 && <p className="relative edge rounded-panel bg-raise p-4 text-sm text-ink-muted shadow-e2">{t("invites.empty")}</p>}
      {!!invites.data?.length && (
        <ul aria-label={t("invites.list")} className="relative edge flex flex-col gap-0.5 rounded-panel bg-raise p-2 shadow-e2">
          {invites.data.map((i) => (
            <InviteRow key={i.code} invite={i} status={inviteStatus(i, now)} canRevoke={canRevokeInvite(ctx.standing, i)} onRevoke={() => setRevoking(i)} />
          ))}
        </ul>
      )}
      <Dialog open={!!revoking} onClose={() => setRevoking(null)} title={t("invites.revokeTitle", { code: revoking?.code ?? "" })}>
        {revoking && (
          <ConfirmBody body={t("invites.revokeBody")} submit={t("invites.revoke")} onDone={() => setRevoking(null)} action={() => admin.revokeInvite(ctx.guildId, revoking.code)} />
        )}
      </Dialog>
    </div>
  );
}

function InviteRow({ invite: i, status, canRevoke, onRevoke }: { invite: InviteDto; status: ReturnType<typeof inviteStatus>; canRevoke: boolean; onRevoke: () => void }) {
  const { copied, copy } = useCopy();
  const uses = i.maxUses === null ? t("invites.usesUnlimited", { uses: String(i.uses) }) : t("invites.uses", { uses: String(i.uses), max: String(i.maxUses) });
  const expiry = status === "expired" ? t("invites.expired") : status === "used" ? t("invites.usedUp") : i.expiresAt ? t("invites.expires", { date: when(i.expiresAt) }) : t("invites.never");
  return (
    <li data-invite={i.code} className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 rounded-control px-3 py-1.5">
      <div className="min-w-0 flex-1 basis-56">
        <p className={`font-mono text-[15px] tracking-wide select-text ${status === "active" ? "" : "text-ink-muted line-through"}`}>{i.code}</p>
        <p className="truncate text-small text-ink-muted">
          {t("invites.by", { name: i.createdBy.username })} · <span className="numeric">{uses}</span> · {expiry}
        </p>
      </div>
      <Tooltip label={copied ? t("common.copied") : t("invites.copy", { code: i.code })}>
        <button type="button" onClick={() => void copy(i.code)} aria-label={t("invites.copy", { code: i.code })} className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink active:scale-[.98]">
          {copied ? <Check aria-hidden="true" className="text-moss-300" /> : <Copy aria-hidden="true" />}
        </button>
      </Tooltip>
      <p aria-live="polite" className="sr-only">
        {copied ? t("common.copied") : ""}
      </p>
      {canRevoke && (
        <Button type="button" variant="ghost" onClick={onRevoke} aria-label={t("invites.revokeLabel", { code: i.code })} className="text-danger!">
          {t("invites.revoke")}
        </Button>
      )}
    </li>
  );
}
