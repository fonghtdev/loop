import { Crown } from "@phosphor-icons/react";
import { useMemo } from "react";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/errors";
import { groupMembers } from "../lib/members";
import type { Member } from "../lib/permissions";
import { useGuild, useMembers, useRoles } from "../lib/queries";
import { Avatar } from "./Avatar";
import { ColumnHeader, LoadError, Skeleton } from "./States";
import { Tooltip } from "./Tooltip";

/**
 * The member column: the owner, then one section per role (each member under their highest role), then everyone else.
 * Without the roles (still loading or failed) it is the plain list.
 */
// ponytail: no online dots here; the server only tracks presence for friends (add when guild presence exists)
export function MemberList({ guildId }: { guildId: string }) {
  const members = useMembers(guildId);
  const roles = useRoles(guildId);
  const ownerId = useGuild(guildId).data?.guild.ownerId;
  const groups = useMemo(() => (members.data ? groupMembers(members.data, roles.data, guildId, ownerId) : null), [members.data, roles.data, guildId, ownerId]);
  return (
    <>
      <ColumnHeader>{members.data ? t("members.count", { count: String(members.data.length) }) : t("shell.members")}</ColumnHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {members.isPending && <Skeleton rows={5} />}
        {members.isError && <LoadError message={errorMessage(members.error)} onRetry={() => void members.refetch()} />}
        {groups
          ? groups.map((g) => (
              <section key={g.key} aria-labelledby={`mg-${g.key}`}>
                <h2 id={`mg-${g.key}`} className="flex items-baseline gap-2 px-2 pt-4 pb-1 text-micro font-bold tracking-[.08em] text-ink-faint uppercase">
                  <span className="min-w-0 truncate">{g.key === "owner" ? t("members.owner") : (g.roleName ?? t("shell.members"))}</span>
                  <span className="numeric shrink-0">{g.members.length}</span>
                </h2>
                <MemberRows list={g.members} ownerId={ownerId} named={false} />
              </section>
            ))
          : members.data && <MemberRows list={members.data} ownerId={ownerId} named />}
      </div>
    </>
  );
}

/** `named`: the crown says "Chủ máy chủ" itself (the flat list); in a section the section title already does. */
function MemberRows({ list, ownerId, named }: { list: Member[]; ownerId: string | undefined; named: boolean }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {list.map((m) => (
        <li key={m.userId} className="flex h-11 items-center gap-2.5 rounded-control px-2 hover:bg-white/[.045]">
          <Avatar id={m.userId} name={m.username} className="size-8 rounded-full text-xs" />
          <span className="min-w-0 flex-1 truncate text-ui text-ink-muted select-text">{m.username}</span>
          {m.userId === ownerId &&
            (named ? (
              <Tooltip label={t("members.owner")}>
                <span className="shrink-0 text-warning">
                  <Crown aria-hidden="true" weight="fill" size={16} />
                  <span className="sr-only">{t("members.owner")}</span>
                </span>
              </Tooltip>
            ) : (
              <Crown aria-hidden="true" weight="fill" size={16} className="shrink-0 text-warning" />
            ))}
        </li>
      ))}
    </ul>
  );
}
