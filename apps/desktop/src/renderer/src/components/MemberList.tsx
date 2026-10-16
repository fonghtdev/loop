import { Crown } from "@phosphor-icons/react";
import type { PresenceStatus } from "@loop/shared";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/errors";
import { groupMembers } from "../lib/member-groups";
import type { Member, Role } from "../lib/permissions";
import { useGuild, useMembers, useRoles } from "../lib/queries";
import { useNameOf } from "../lib/identity-hooks";
import { useStatusOf } from "../lib/presence-hooks";
import { nameColorOf } from "../lib/role-colors";
import { PresenceAvatar } from "./Avatar";
import { ColumnHeader, LoadError, Skeleton } from "./States";
import { Tooltip } from "./Tooltip";
import { UserCardTrigger } from "./UserCard";

/**
 * The member column, grouped like Discord (lib/member-groups.ts): online people by role, online without role, one
 * offline group. Derived from members + roles + presence on every render, so role and status changes move people live.
 */
export function MemberList({ guildId }: { guildId: string }) {
  const members = useMembers(guildId);
  const roles = useRoles(guildId);
  const ownerId = useGuild(guildId).data?.guild.ownerId;
  const statusOf = useStatusOf();
  const nameOf = useNameOf();
  const groups = members.data ? groupMembers(members.data, roles.data ?? [], guildId, statusOf, (m) => nameOf(m.userId, m.username)) : null;
  return (
    <>
      <ColumnHeader>{members.data ? t("members.count", { count: String(members.data.length) }) : t("shell.members")}</ColumnHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {members.isPending && <Skeleton rows={5} />}
        {members.isError && <LoadError message={errorMessage(members.error)} onRetry={() => void members.refetch()} />}
        {groups?.map((g) => (
          <section key={g.key} aria-labelledby={`mg-${g.key}`}>
            <h2 id={`mg-${g.key}`} className="flex items-baseline gap-2 px-2 pt-4 pb-1 text-micro font-bold tracking-[.08em] text-ink-faint uppercase">
              <span className="min-w-0 truncate">{g.key === "online" ? t("members.online") : g.key === "offline" ? t("members.offline") : g.roleName}</span>
              <span className="numeric shrink-0">— {g.members.length}</span>
            </h2>
            <MemberRows list={g.members} roles={roles.data ?? []} ownerId={ownerId} guildId={guildId} statusOf={statusOf} />
          </section>
        ))}
      </div>
    </>
  );
}

type MemberRowsProps = { list: Member[]; roles: Role[]; ownerId: string | undefined; guildId: string; statusOf: (userId: string) => PresenceStatus };

function MemberRows({ list, roles, ownerId, guildId, statusOf }: MemberRowsProps) {
  const nameOf = useNameOf();
  return (
    <ul className="flex flex-col gap-0.5">
      {list.map((m) => (
        <li key={m.userId} className="flex h-11 items-center gap-2.5 rounded-control px-2 hover:bg-white/[.045]">
          <UserCardTrigger user={{ id: m.userId, username: m.username }} guildId={guildId} className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-control text-ui text-ink-muted">
            <PresenceAvatar id={m.userId} name={nameOf(m.userId, m.username)} status={statusOf(m.userId)} size={12} className="size-8 rounded-full text-xs" />
            <span className="min-w-0 flex-1 truncate" style={{ color: nameColorOf(m.roleIds, roles, guildId) }}>
              {nameOf(m.userId, m.username)}
            </span>
          </UserCardTrigger>
          {m.userId === ownerId && (
            <Tooltip label={t("members.owner")}>
              <span className="shrink-0 text-warning">
                <Crown aria-hidden="true" weight="fill" size={16} />
                <span className="sr-only">{t("members.owner")}</span>
              </span>
            </Tooltip>
          )}
        </li>
      ))}
    </ul>
  );
}
