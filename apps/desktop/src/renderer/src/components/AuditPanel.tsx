import type { AuditUser } from "@loop/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { t } from "../i18n/t";
import type { SettingsCtx } from "../lib/admin";
import { admin } from "../lib/app";
import { actorChoices, AUDIT_FILTERS, auditQuery, auditSentence, exactTime, relativeTime } from "../lib/audit";
import { errorMessage } from "../lib/errors";
import { avatarUrl } from "../lib/identity";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { LoadError, Skeleton } from "./States";
import { Tooltip } from "./Tooltip";

const nameOf = (u: AuditUser) => u.displayName || u.username;
const selectClass = "h-11 w-full min-w-0 truncate rounded-control border border-line-strong bg-surface-3 px-3 text-chat text-ink";

/** The audit log (VIEW_AUDIT_LOG, gated by settingsSections): filter by group and actor, newest first, "Xem thêm" pages back. */
export function AuditPanel({ ctx }: { ctx: SettingsCtx }) {
  const [group, setGroup] = useState("");
  const [actorId, setActorId] = useState("");
  const groupId = useId();
  const actorFieldId = useId();
  const log = useInfiniteQuery({
    queryKey: ["guild", ctx.guildId, "audit", group, actorId],
    queryFn: ({ pageParam }) => admin.auditLog(ctx.guildId, auditQuery({ group, actorId, before: pageParam })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.entries.at(-1)?.id : undefined),
  });
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  const members = ctx.members.map((m): AuditUser => ({ id: m.userId, username: m.username, displayName: m.displayName ?? null, avatarHash: m.avatarHash ?? null }));
  const actors = actorChoices(entries, members, nameOf);
  const channelName = (id: string) => ctx.channels.find((c) => c.id === id)?.name;
  const now = Date.now();

  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <p className="text-sm text-ink-muted">{t("audit.intro")}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={groupId} className="text-sm font-medium text-ink">
            {t("audit.filter.group")}
          </label>
          <select id={groupId} value={group} onChange={(e) => setGroup(e.target.value)} className={selectClass}>
            {AUDIT_FILTERS.map((f) => (
              <option key={f.group} value={f.group}>
                {t(f.label)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={actorFieldId} className="text-sm font-medium text-ink">
            {t("audit.filter.actor")}
          </label>
          <select id={actorFieldId} value={actorId} onChange={(e) => setActorId(e.target.value)} className={selectClass}>
            <option value="">{t("audit.filter.anyone")}</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {nameOf(a)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {log.isError && <LoadError message={errorMessage(log.error)} onRetry={() => void log.refetch()} />}
      {log.isPending && <Skeleton rows={5} />}
      {log.data && entries.length === 0 && (
        <p className="relative edge rounded-panel bg-raise p-4 text-sm text-ink-muted shadow-e2">{t(group || actorId ? "audit.emptyFiltered" : "audit.empty")}</p>
      )}
      {entries.length > 0 && (
        <ul aria-label={t("audit.list")} className="relative edge flex flex-col gap-0.5 rounded-panel bg-raise p-2 shadow-e2">
          {entries.map((e) => {
            const { text, detail } = auditSentence(e, { nameOf, channelName });
            return (
              <li key={e.id} className="flex min-h-14 items-start gap-3 rounded-control px-3 py-2">
                {e.actor ? (
                  <Avatar id={e.actor.id} name={nameOf(e.actor)} image={avatarUrl(e.actor.id, e.actor.avatarHash)} className="mt-0.5 size-8 shrink-0 rounded-full text-xs" />
                ) : (
                  <span aria-hidden="true" className="mt-0.5 size-8 shrink-0 rounded-full bg-surface-4" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-ui break-words [overflow-wrap:anywhere]">{text}</p>
                  {detail && <p className="text-small break-words text-ink-muted [overflow-wrap:anywhere]">{detail}</p>}
                  <Tooltip label={exactTime(e.createdAt)}>
                    <time dateTime={e.createdAt} tabIndex={0} className="text-caption text-ink-faint">
                      {relativeTime(e.createdAt, now)}
                    </time>
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {log.hasNextPage && (
        <Button type="button" variant="secondary" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()} className="self-start">
          {t("audit.more")}
        </Button>
      )}
    </div>
  );
}
