import { ChatsCircle, SignOut, UsersThree } from "@phosphor-icons/react";
import { useEffect, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { ChannelColumn } from "../components/ChannelColumn";
import { ChatView } from "../components/ChatView";
import { DmColumn } from "../components/DmColumn";
import { DmView } from "../components/DmView";
import { ImageViewer } from "../components/ImageViewer";
import { IncomingCall } from "../components/IncomingCall";
import { MemberList } from "../components/MemberList";
import { ServerRail } from "../components/ServerRail";
import { ServerSettings } from "../components/ServerSettings";
import { UserSettings } from "../components/UserSettings";
import { VoiceBar } from "../components/VoiceBar";
import { VoiceRoom } from "../components/VoiceRoom";
import { ColumnHeader, EmptyState } from "../components/States";
import { t } from "../i18n/t";
import { ApiError } from "../lib/auth-client";
import { realtime, revalidateGuild, session, unread, voice, voicePresence } from "../lib/app";
import { goHome, readLastPlace, useNav } from "../lib/nav";
import { blockFileNavigation } from "../lib/drop";
import { useDms, useGuild, useGuilds } from "../lib/queries";
import { FriendsScreen } from "./FriendsScreen";

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
  const dmId = useNav((s) => s.dmId);
  const settings = useNav((s) => s.settings);
  const channelId = useValidPlace();
  const channels = useGuild(guildId).data?.channels;
  const voiceChannelIds = channels?.filter((c) => c.type === "VOICE").map((c) => c.id);
  const notice = useStore(voice.store, (s) => s.notice);
  const isVoiceChannel = !!channels?.some((c) => c.id === channelId && c.type === "VOICE");

  // The voice channels of the open server are watched for who is in them (see realtime.setWatched); the key keeps
  // the effect from re-running on every refetch of the same list.
  const watchKey = voiceChannelIds?.join(",") ?? "";
  useEffect(() => {
    realtime.setWatched(watchKey ? watchKey.split(",") : []);
    return () => realtime.setWatched([]);
  }, [watchKey]);
  useEffect(() => voicePresence.clear(), [guildId]);

  // The text channels of the open server are listened to for unread counts, the DM list drives restart detection.
  const textKey = channels?.filter((c) => c.type === "TEXT").map((c) => c.id).join(",") ?? "";
  useEffect(() => {
    realtime.setTracked(textKey ? textKey.split(",") : []);
    return () => realtime.setTracked([]);
  }, [textKey]);
  const dms = useDms().data;
  useEffect(() => {
    if (dms) unread.reconcileDms(dms);
  }, [dms]);

  useEffect(() => {
    if (user) useNav.setState(readLastPlace(user.id));
  }, [user?.id]); // only when the account changes, not on every user object

  // A dropped file must never navigate the window to it (the conversation's own drop zone handles real drops).
  useEffect(() => blockFileNavigation(window), []);

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
        {notice && (
          <Banner tone="warning" className="rounded-none! items-center">
            <span className="flex flex-wrap items-center gap-x-3">
              {notice}
              <Button variant="link" onClick={() => voice.dismissNotice()} className="h-8 px-0">
                {t("voice.notice.dismiss")}
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

        <nav aria-label={t("shell.channels")} className="grain flex min-h-0 min-w-0 flex-col border-r border-hair bg-surface-1 [--grain-under:var(--background-image-chan)]">
          {guildId ? (
            <ChannelColumn guildId={guildId} />
          ) : (
            <DmColumn />
          )}
          <VoiceBar />
          <section aria-label={t("shell.account")} className="grain flex h-16 shrink-0 items-center gap-3 border-t border-hair bg-surface-0 px-3 shadow-[inset_0_1px_0_var(--color-highlight)]">
            <button
              type="button"
              onClick={() => useNav.setState({ settings: "user" })}
              aria-label={t("userSettings.open")}
              title={t("userSettings.open")}
              aria-current={settings === "user" ? "page" : undefined}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-control py-1 text-left transition-colors duration-(--duration-fast) hover:bg-surface-4"
            >
              <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-moss-900 font-display font-bold text-moss-200">
                {user?.username.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{user?.username}</span>
                <span className="block truncate text-xs text-ink-muted">{user?.email}</span>
              </span>
            </button>
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

        <main className="grain flex min-h-0 min-w-0 flex-col bg-surface-2">
          {settings === "user" ? (
            <UserSettings />
          ) : guildId && settings ? (
            <ServerSettings guildId={guildId} />
          ) : guildId && channelId ? (
            isVoiceChannel ? <VoiceRoom guildId={guildId} channelId={channelId} /> : <ChatView guildId={guildId} channelId={channelId} />
          ) : guildId ? (
            <>
              <ColumnHeader>{" "}</ColumnHeader>
              <div className="p-6">
                <EmptyState icon={<ChatsCircle />} title={t("chat.noChannelTitle")} body={t("chat.noChannelBody")} />
              </div>
            </>
          ) : dmId ? (
            <DmView dmId={dmId} />
          ) : (
            <FriendsScreen />
          )}
        </main>

        <aside aria-label={t("shell.members")} className="grain flex min-h-0 min-w-0 flex-col border-l border-hair bg-surface-1">
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
      <ImageViewer />
      <IncomingCall />
    </div>
  );
}

/**
 * Keeps the place valid as data arrives: a server we are no longer in -> home; a channel we cannot open (gone,
 * hidden) -> the first text channel. Returns the channel to show (null while unknown).
 */
function useValidPlace(): string | null {
  const guildId = useNav((s) => s.guildId);
  const channelId = useNav((s) => s.channelId);
  const guilds = useGuilds().data;
  const guild = useGuild(guildId);
  const dmId = useNav((s) => s.dmId);
  const dms = useDms().data;

  // a DM that is not in the list (any more) -> the Friends screen
  useEffect(() => {
    if (!guildId && dmId && dms && !dms.some((d) => d.id === dmId)) useNav.setState({ dmId: null });
  }, [guildId, dmId, dms]);

  const lostGuild = guild.error instanceof ApiError && guild.error.status === 404;
  useEffect(() => {
    if (!guildId) return;
    if ((guilds && !guilds.some((g) => g.id === guildId)) || lostGuild) {
      if (lostGuild) revalidateGuild(null);
      goHome();
    }
  }, [guildId, guilds, lostGuild]);

  const channels = guild.data?.channels;
  const valid = !!channels?.some((c) => c.id === channelId);
  useEffect(() => {
    const fallback = channels?.find((c) => c.type === "TEXT")?.id ?? null;
    if (channels && !valid && useNav.getState().channelId !== fallback) useNav.setState({ channelId: fallback });
  }, [channels, valid]);

  return valid ? channelId : null;
}
