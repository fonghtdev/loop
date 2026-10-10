import { UsersThree } from "@phosphor-icons/react";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/errors";
import { arrowNav } from "../lib/focus";
import { useNav } from "../lib/nav";
import { useDms, useIsOnline } from "../lib/queries";
import { PresenceAvatar } from "./Avatar";
import { ColumnHeader, EmptyState, LoadError, Skeleton } from "./States";

/** Home's channel column: the Friends entry, then the DMs (newest activity first) with an online dot. */
export function DmColumn() {
  const dms = useDms();
  const isOnline = useIsOnline();
  const dmId = useNav((s) => s.dmId);
  return (
    <>
      <ColumnHeader>{t("home.dms")}</ColumnHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <ul aria-label={t("home.dmList")} onKeyDown={arrowNav} className="flex flex-col gap-0.5">
          <li>
            <button
              type="button"
              data-nav-item
              aria-current={dmId === null ? "page" : undefined}
              onClick={() => useNav.setState({ dmId: null })}
              className={`flex h-10 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-[15px] transition-colors duration-(--duration-fast) ${dmId === null ? "bg-surface-4 font-semibold text-ink" : "text-ink-muted hover:bg-surface-3 hover:text-ink"}`}
            >
              <UsersThree aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("home.friends")}</span>
            </button>
          </li>
          {dms.data?.map((dm) => (
            <li key={dm.id}>
              <button
                type="button"
                data-nav-item
                aria-current={dm.id === dmId ? "page" : undefined}
                onClick={() => useNav.setState({ dmId: dm.id })}
                className={`flex h-12 w-full items-center gap-2.5 rounded-control px-2 text-left text-[15px] transition-colors duration-(--duration-fast) ${dm.id === dmId ? "bg-surface-4 font-semibold text-ink" : "text-ink-muted hover:bg-surface-3 hover:text-ink"}`}
              >
                <PresenceAvatar id={dm.user.id} name={dm.user.username} online={isOnline(dm.user)} className="size-8 rounded-full text-xs" />
                <span title={dm.user.username} className="min-w-0 flex-1 truncate">
                  {dm.user.username}
                </span>
              </button>
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
            <EmptyState icon={<UsersThree />} title={t("home.noDmsTitle")} body={t("home.noDmsBody")} />
          </div>
        )}
      </div>
    </>
  );
}
