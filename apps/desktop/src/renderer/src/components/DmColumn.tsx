import { UsersThree } from "@phosphor-icons/react";
import type { PresenceStatus } from "@loop/shared";
import type { Dm } from "../lib/social";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/errors";
import { arrowNav } from "../lib/focus";
import { useNav } from "../lib/nav";
import { dmKey } from "../lib/conversation";
import { useStatusOf } from "../lib/presence-hooks";
import { useDms } from "../lib/queries";
import { useUnreadMark } from "../lib/unread-hooks";
import { Badge, UnreadDot } from "./Badge";
import { navRow } from "./navRow";
import { QuickSwitchButton } from "./QuickSwitcher";
import { PresenceAvatar } from "./Avatar";
import { FriendsArt } from "./Illustrations";
import { ColumnHeader, EmptyState, LoadError, Skeleton } from "./States";
import { Tooltip } from "./Tooltip";

/** Home's channel column: the Friends entry, then the DMs (newest activity first) with an online dot. */
export function DmColumn() {
  const dms = useDms();
  const statusOf = useStatusOf();
  const dmId = useNav((s) => s.dmId);
  return (
    <>
      <ColumnHeader>
        <span className="min-w-0 flex-1 truncate">{t("home.dms")}</span>
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
              <DmRow dm={dm} active={dm.id === dmId} status={statusOf(dm.user.id)} />
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

function DmRow({ dm, active, status }: { dm: Dm; active: boolean; status: PresenceStatus }) {
  const { count, dot } = useUnreadMark(dmKey(dm.id));
  const unread = count > 0 || dot;
  return (
    <button
      type="button"
      data-nav-item
      data-unread={unread ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={() => useNav.setState({ dmId: dm.id })}
      className={`h-12 w-full ${navRow(active, unread, "gap-2.5 px-2")}`}
    >
      <PresenceAvatar id={dm.user.id} name={dm.user.username} status={status} className="size-8 rounded-full text-xs" />
      <Tooltip label={dm.user.username}>
        <span className="min-w-0 flex-1 truncate">{dm.user.username}</span>
      </Tooltip>
      {count > 0 && <Badge count={count} />}
      {dot && <UnreadDot />}
    </button>
  );
}
