import { ChatsCircle, SignOut, UsersThree } from "@phosphor-icons/react";
import { useEffect, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { ChannelColumn } from "../components/ChannelColumn";
import { ChatView } from "../components/ChatView";
import { LogoMark } from "../components/Logo";
import { MemberList } from "../components/MemberList";
import { ServerRail } from "../components/ServerRail";
import { ColumnHeader, EmptyState } from "../components/States";
import { t } from "../i18n/t";
import { ApiError } from "../lib/auth-client";
import { realtime, revalidateGuild, session } from "../lib/app";
import { goHome, readLastPlace, useNav } from "../lib/nav";
import { useGuild, useGuilds } from "../lib/queries";

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
 * The signed-in frame: server rail | channel column (+ user panel) | main | members, with a notice row on top.
 * Column widths are fixed so nothing jumps; only the main column flexes (min window 960px wide).
 */
export function Shell() {
  const { user, persistent } = session.useSession();
  const online = useOnline();
  const connection = useStore(realtime.state, (s) => s.status);
  const guildId = useNav((s) => s.guildId);
  const channelId = useValidPlace();

  useEffect(() => {
    if (user) useNav.setState(readLastPlace(user.id));
  }, [user?.id]); // only when the account changes, not on every user object

  return (
    <div className="flex h-full flex-col">
      <div aria-live="polite" className="flex flex-col gap-px empty:hidden">
        {!online && (
          <Banner tone="offline" className="rounded-none!">
            {t("notice.offline")}
          </Banner>
        )}
        {online && connection === "reconnecting" && (
          <Banner tone="offline" className="rounded-none!">
            {t("notice.reconnecting")}
          </Banner>
        )}
        {connection === "failed" && (
          <Banner tone="danger" className="rounded-none! items-center">
            <span className="flex flex-wrap items-center gap-x-3">
              {t("notice.realtimeFailed")}
              <Button variant="link" onClick={() => realtime.retry()} className="h-8 px-0">
                {t("common.retry")}
              </Button>
            </span>
          </Banner>
        )}
        {!persistent && (
          <Banner tone="warning" className="rounded-none!">
            {t("notice.sessionOnly")}
          </Banner>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[72px_240px_minmax(0,1fr)_240px]">
        <ServerRail />

        <nav aria-label={t("shell.channels")} className="flex min-h-0 min-w-0 flex-col bg-surface-1">
          {guildId ? (
            <ChannelColumn guildId={guildId} />
          ) : (
            <>
              <ColumnHeader>{t("app.name")}</ColumnHeader>
              <div className="flex-1 overflow-y-auto p-4">
                <EmptyState icon={<ChatsCircle />} title={t("home.channelsTitle")} body={t("home.channelsBody")} />
              </div>
            </>
          )}
          <section aria-label={t("shell.account")} className="flex h-16 shrink-0 items-center gap-3 bg-surface-0 px-3">
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
          {guildId && channelId ? (
            <ChatView guildId={guildId} channelId={channelId} />
          ) : guildId ? (
            <>
              <ColumnHeader>{" "}</ColumnHeader>
              <div className="p-6">
                <EmptyState icon={<ChatsCircle />} title={t("chat.noChannelTitle")} body={t("chat.noChannelBody")} />
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
        </main>

        <aside aria-label={t("shell.members")} className="flex min-h-0 min-w-0 flex-col bg-surface-1">
          {guildId ? (
            <MemberList guildId={guildId} />
          ) : (
            <>
              <ColumnHeader>{t("shell.members")}</ColumnHeader>
              <div className="flex-1 overflow-y-auto p-4">
                <EmptyState icon={<UsersThree />} body={t("shell.membersEmpty")} />
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * Keeps the place valid as data arrives: a server we are no longer in -> home; a channel we cannot open (gone,
 * hidden, voice) -> the first text channel. Returns the channel to show (null while unknown).
 */
function useValidPlace(): string | null {
  const guildId = useNav((s) => s.guildId);
  const channelId = useNav((s) => s.channelId);
  const guilds = useGuilds().data;
  const guild = useGuild(guildId);

  const lostGuild = guild.error instanceof ApiError && guild.error.status === 404;
  useEffect(() => {
    if (!guildId) return;
    if ((guilds && !guilds.some((g) => g.id === guildId)) || lostGuild) {
      if (lostGuild) revalidateGuild(null);
      goHome();
    }
  }, [guildId, guilds, lostGuild]);

  const text = guild.data?.channels.filter((c) => c.type === "TEXT");
  const valid = !!text?.some((c) => c.id === channelId);
  useEffect(() => {
    const fallback = text?.[0]?.id ?? null;
    if (text && !valid && useNav.getState().channelId !== fallback) useNav.setState({ channelId: fallback });
  }, [text, valid]);

  return valid ? channelId : null;
}
