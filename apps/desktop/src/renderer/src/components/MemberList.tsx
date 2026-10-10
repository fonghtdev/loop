import { Crown } from "@phosphor-icons/react";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/errors";
import { useGuild, useMembers } from "../lib/queries";
import { Avatar } from "./Avatar";
import { ColumnHeader, LoadError, Skeleton } from "./States";

// ponytail: no online dots here; the server only tracks presence for friends (add when guild presence exists)
export function MemberList({ guildId }: { guildId: string }) {
  const members = useMembers(guildId);
  const ownerId = useGuild(guildId).data?.guild.ownerId;
  return (
    <>
      <ColumnHeader>{members.data ? t("members.count", { count: String(members.data.length) }) : t("shell.members")}</ColumnHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {members.isPending && <Skeleton rows={5} />}
        {members.isError && <LoadError message={errorMessage(members.error)} onRetry={() => void members.refetch()} />}
        <ul className="flex flex-col gap-0.5">
          {members.data?.map((m) => (
            <li key={m.userId} className="flex h-11 items-center gap-2.5 rounded-control px-2">
              <Avatar id={m.userId} name={m.username} className="size-8 rounded-full text-xs" />
              <span className="min-w-0 flex-1 truncate text-sm text-ink-muted select-text">{m.username}</span>
              {m.userId === ownerId && (
                <span title={t("members.owner")} className="shrink-0 text-warning">
                  <Crown aria-hidden="true" weight="fill" size={16} />
                  <span className="sr-only">{t("members.owner")}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
