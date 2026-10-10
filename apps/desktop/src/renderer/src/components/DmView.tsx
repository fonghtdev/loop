import { ChatsCircle } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { chat } from "../lib/app";
import { dmKey } from "../lib/conversation";
import { useBlocks, useDms, useFriends, useIsOnline } from "../lib/queries";
import { dmComposerState, type DmComposerState } from "../lib/social";
import { PresenceAvatar } from "./Avatar";
import { Conversation } from "./ChatView";
import { ColumnHeader, Skeleton } from "./States";

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
          <h1 title={name} className="min-w-0 truncate">
            {name}
          </h1>
          <span className="shrink-0 text-xs font-normal text-ink-muted">{online ? t("presence.online") : t("presence.offline")}</span>
        </>
      }
      logLabel={t("dm.log", { name })}
      start={{ icon: <ChatsCircle size={24} />, title: t("dm.startTitle", { name }), body: t("dm.startBody") }}
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
