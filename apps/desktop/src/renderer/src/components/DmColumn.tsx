import { UsersThree } from "@phosphor-icons/react";
import type { PresenceStatus } from "@loop/shared";
import { isGroup, type GroupDm, type PairDm } from "../lib/social";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/errors";
import { arrowNav } from "../lib/focus";
import { useNav } from "../lib/nav";
import { dmKey } from "../lib/conversation";
import { useDisplayName } from "../lib/identity-hooks";
import { useStatusOf } from "../lib/presence-hooks";
import { useDms } from "../lib/queries";
import { useUnreadCount } from "../lib/unread-hooks";
import { Badge } from "./Badge";
import { navRow } from "./navRow";
import { QuickSwitchButton } from "./QuickSwitcher";
import { PresenceAvatar } from "./Avatar";
import { FriendsArt } from "./Illustrations";
import { ColumnHeader, EmptyState, LoadError, Skeleton } from "./States";
import { Tooltip } from "./Tooltip";
import { CreateGroupButton, GroupAvatar, useGroupTitle } from "./GroupDm";

/** Home's channel column: the Friends entry, then the DMs (newest activity first) with an online dot. */
export function DmColumn() {
  const dms = useDms();
  const statusOf = useStatusOf();
  const dmId = useNav((s) => s.dmId);
  return (
    <>
      <ColumnHeader>
        <span className="min-w-0 flex-1 truncate">{t("home.dms")}</span>
        <CreateGroupButton />
        <QuickSwitchButton />
      </ColumnHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <ul aria-label={t("home.dmList")} onKeyDown={arrowNav} className="flex flex-col gap-0.5">
          <li>
            <button
              type="button"
              data-nav-item
              aria-current={dmId === null ? "page" : undefined}
              onClick={() => useNav.setState({ dmId: null })}
              className={`h-10 w-full ${navRow(dmId === null)}`}
            >
              <UsersThree aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("home.friends")}</span>
            </button>
          </li>
          {dms.data?.map((dm) => (
            <li key={dm.id}>
              {isGroup(dm) ? <GroupRow dm={dm} active={dm.id === dmId} /> : <DmRow dm={dm} active={dm.id === dmId} status={statusOf(dm.user.id)} />}
            </li>
          ))}
        </ul>
        {dms.isPending && (
          <div className="mt-3">
            <Skeleton rows={5} />
          </div>
        )}
        {dms.isError && (
          <div className="mt-3">
            <LoadError message={errorMessage(dms.error)} onRetry={() => void dms.refetch()} />
          </div>
        )}
        {dms.data?.length === 0 && (
          <div className="mt-3">
            <EmptyState art={<FriendsArt />} title={t("home.noDmsTitle")} body={t("home.noDmsBody")} />
          </div>
        )}
      </div>
    </>
  );
}

/** A group row: stacked avatars, the name (or "A, B, C") and how many people are in it. */
function GroupRow({ dm, active }: { dm: GroupDm; active: boolean }) {
  const name = useGroupTitle(dm);
  const count = useUnreadCount(dmKey(dm.id));
  const unread = count > 0;
  return (
    <button
      type="button"
      data-nav-item
      data-unread={unread ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={() => useNav.setState({ dmId: dm.id })}
      className={`h-12 w-full ${navRow(active, unread, "gap-2.5 px-2")}`}
    >
      <GroupAvatar g={dm} />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <Tooltip label={name}>
          <span className="truncate">{name}</span>
        </Tooltip>
        <span className="numeric truncate text-caption font-normal text-ink-faint">{t("group.memberCount", { count: String(dm.participants.length) })}</span>
      </span>
      {count > 0 && <Badge count={count} />}
    </button>
  );
}

function DmRow({ dm, active, status }: { dm: PairDm; active: boolean; status: PresenceStatus }) {
  const name = useDisplayName(dm.user.id, dm.user.username);
  const count = useUnreadCount(dmKey(dm.id));
  const unread = count > 0;
  return (
    <button
      type="button"
      data-nav-item
      data-unread={unread ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={() => useNav.setState({ dmId: dm.id })}
      className={`h-12 w-full ${navRow(active, unread, "gap-2.5 px-2")}`}
    >
      <PresenceAvatar id={dm.user.id} name={name} status={status} className="size-8 rounded-full text-xs" />
      <Tooltip label={name}>
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </Tooltip>
      {count > 0 && <Badge count={count} />}
    </button>
  );
}
