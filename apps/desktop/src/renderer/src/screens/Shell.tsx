import { ChatsCircle, Plus, SignOut, UsersThree } from "@phosphor-icons/react";
import { useSyncExternalStore, type ReactNode } from "react";
import { Banner } from "../components/Banner";
import { LogoMark } from "../components/Logo";
import { t } from "../i18n/t";
import { session } from "../lib/app";

const subscribeOnline = (cb: () => void) => {
  addEventListener("online", cb);
  addEventListener("offline", cb);
  return () => {
    removeEventListener("online", cb);
    removeEventListener("offline", cb);
  };
};
const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine);

/**
 * The signed-in frame 9b-9f fill in: server rail | channel column (+ user panel) | main | members, with a notice
 * row on top. Column widths are fixed so nothing jumps; only the main column flexes (min window 960px wide).
 */
export function Shell() {
  const { user, persistent } = session.useSession();
  const online = useOnline();
  return (
    <div className="flex h-full flex-col">
      <div aria-live="polite" className="flex flex-col gap-px empty:hidden">
        {!online && (
          <Banner tone="offline" className="rounded-none!">
            {t("notice.offline")}
          </Banner>
        )}
        {!persistent && (
          <Banner tone="warning" className="rounded-none!">
            {t("notice.sessionOnly")}
          </Banner>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[72px_240px_minmax(0,1fr)_240px]">
        <nav aria-label={t("shell.servers")} className="flex flex-col items-center gap-2 bg-surface-0 py-3">
          <div className="relative">
            <span aria-hidden="true" className="absolute top-1/2 -left-3 h-8 w-1 -translate-y-1/2 rounded-r-full bg-moss-300" />
            <button
              type="button"
              aria-label={t("shell.home")}
              aria-current="page"
              title={t("shell.home")}
              className="grid size-12 place-items-center rounded-control bg-surface-3 text-moss-300"
            >
              <LogoMark className="size-7" />
            </button>
          </div>
          <div aria-hidden="true" className="h-px w-8 bg-line" />
          <button
            type="button"
            aria-label={t("shell.addServer")}
            aria-disabled="true"
            title={t("shell.addServer")}
            className="grid size-12 place-items-center rounded-control border border-dashed border-line-strong text-ink-faint cursor-not-allowed"
          >
            <Plus aria-hidden="true" />
          </button>
        </nav>

        <nav aria-label={t("shell.channels")} className="flex min-h-0 flex-col bg-surface-1">
          <ColumnHeader>{t("app.name")}</ColumnHeader>
          <div className="flex-1 overflow-y-auto p-4">
            <EmptyState icon={<ChatsCircle />} title={t("shell.channelsEmptyTitle")} body={t("shell.channelsEmptyBody")} />
          </div>
          <section aria-label={t("shell.account")} className="flex h-16 items-center gap-3 bg-surface-0/60 px-3">
            <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-moss-900 font-display font-bold text-moss-200">
              {user?.username.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 select-text">
              <span className="block truncate text-sm font-semibold">{user?.username}</span>
              <span className="block truncate text-xs text-ink-muted">{user?.email}</span>
            </span>
            <button
              type="button"
              onClick={() => void session.logout()}
              aria-label={t("shell.logout")}
              title={t("shell.logout")}
              className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-4 hover:text-ink"
            >
              <SignOut aria-hidden="true" />
            </button>
          </section>
        </nav>

        <main className="flex min-h-0 min-w-0 flex-col bg-surface-2">
          <ColumnHeader>{t("shell.home")}</ColumnHeader>
          <div className="flex-1 overflow-y-auto px-10 py-12">
            <div className="max-w-[52ch] animate-rise">
              <LogoMark className="size-12 text-moss-300" />
              <h1 className="mt-6 font-display text-[32px] leading-tight font-bold tracking-tight break-words">
                {t("shell.welcomeTitle", { name: user?.username ?? "" })}
              </h1>
              <p className="mt-3 leading-relaxed text-ink-muted">{t("shell.welcomeBody")}</p>
            </div>
          </div>
        </main>

        <aside aria-label={t("shell.members")} className="flex min-h-0 flex-col bg-surface-1">
          <ColumnHeader>{t("shell.members")}</ColumnHeader>
          <div className="flex-1 overflow-y-auto p-4">
            <EmptyState icon={<UsersThree />} body={t("shell.membersEmpty")} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function ColumnHeader({ children }: { children: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center border-b border-line px-4 font-display text-[15px] font-bold">
      <span className="truncate">{children}</span>
    </header>
  );
}

function EmptyState({ icon, title, body }: { icon: ReactNode; title?: string; body: string }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-panel bg-surface-2/60 p-4">
      <span aria-hidden="true" className="grid size-9 place-items-center rounded-control bg-surface-3 text-moss-300">
        {icon}
      </span>
      {title && <p className="mt-1 text-sm font-semibold">{title}</p>}
      <p className="text-[13px] leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}
