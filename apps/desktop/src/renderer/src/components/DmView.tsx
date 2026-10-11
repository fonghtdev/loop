import { ChatsCircle, Phone, VideoCamera } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { calls, chat, voice } from "../lib/app";
import { dmKey } from "../lib/conversation";
import { useBlocks, useDms, useFriends, useIsOnline } from "../lib/queries";
import { dmComposerState, type DmComposerState } from "../lib/social";
import { isActive } from "../lib/voice-hooks";
import { PresenceAvatar } from "./Avatar";
import { Conversation } from "./ChatView";
import { ColumnHeader, Skeleton } from "./States";
import { Tooltip } from "./Tooltip";

/** Why writing is closed in a DM, in words (null = open). History stays readable in every case. */
const closedReason = (state: DmComposerState, name: string) =>
  state === "blocked" ? t("composer.dmBlocked", { name }) : state === "notFriend" || state === "refused" ? t("composer.dmNotFriend", { name }) : null;

/** A DM conversation on Home: the same Conversation as a channel, with the other person in the header. */
export function DmView({ dmId }: { dmId: string }) {
  const key = dmKey(dmId);
  const dm = useDms().data?.find((d) => d.id === dmId);
  const friends = useFriends();
  const blocks = useBlocks();
  const isOnline = useIsOnline();
  const forbiddenAt = useStore(chat.store, (s) => s.convs[key]?.forbiddenAt ?? null);
  const inCall = useStore(voice.store, (s) => s.target?.kind === "dm" && s.target.id === dmId && isActive(s.status));
  const blocked = useMemo(() => new Set(blocks.data?.map((u) => u.id)), [blocks.data]);

  if (!dm)
    return (
      <>
        <ColumnHeader>{" "}</ColumnHeader>
        <div className="p-4">
          <Skeleton rows={6} />
        </div>
      </>
    );

  const name = dm.user.username;
  const online = isOnline(dm.user);
  const state = dmComposerState({ friends: friends.data, friendsUpdatedAt: friends.dataUpdatedAt, blocked, otherId: dm.user.id, forbiddenAt });
  return (
    <Conversation
      convKey={key}
      header={
        <>
          <PresenceAvatar id={dm.user.id} name={name} online={online} ring={2} className="size-8 rounded-full text-xs" />
          <h1 className="min-w-0 truncate">{name}</h1>
          <span className="shrink-0 text-xs font-normal text-ink-muted">{online ? t("presence.online") : t("presence.offline")}</span>
          <span className="ml-auto flex shrink-0 gap-1">
            {[false, true].map((video) => (
              <Tooltip key={String(video)} label={state !== "ok" ? t("call.unavailable") : inCall ? t("call.inCall") : video ? t("call.video") : t("call.voice")}>
                <span className="inline-flex">
                  <button
                    type="button"
                    aria-label={video ? t("call.video") : t("call.voice")}
                    disabled={state !== "ok" || inCall}
                    onClick={() => void calls.start(dmId, name, video)}
                    className="grid size-10 place-items-center rounded-control text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-4 hover:text-ink active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                  >
                    {video ? <VideoCamera aria-hidden="true" /> : <Phone aria-hidden="true" />}
                  </button>
                </span>
              </Tooltip>
            ))}
          </span>
        </>
      }
      logLabel={t("dm.log", { name })}
      start={{ icon: <ChatsCircle size={24} />, title: t("dm.startTitle", { name }), body: t("dm.startBody"), emptyTitle: t("dm.startTitle", { name }), emptyBody: t("dm.emptyBody") }}
      canManage={false}
      composer={{
        label: t("dm.composerLabel", { name }),
        placeholder: t("dm.placeholder", { name }),
        ready: state !== "loading" || friends.isError,
        closedReason: closedReason(state, name),
      }}
    />
  );
}
