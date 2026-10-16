import { ChatsCircle, Phone, VideoCamera } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { calls, chat, voice } from "../lib/app";
import { dmKey } from "../lib/conversation";
import { useNameOf } from "../lib/identity-hooks";
import { useStatusOf } from "../lib/presence-hooks";
import { statusLabel } from "../lib/presence";
import { useBlocks, useDms, useFriends } from "../lib/queries";
import { dmComposerState, isGroup, type DmComposerState, type GroupDm } from "../lib/social";
import { isActive } from "../lib/voice-hooks";
import { PresenceAvatar } from "./Avatar";
import { CallStreams } from "./CallStreams";
import { Conversation } from "./ChatView";
import { ColumnHeader, Skeleton } from "./States";
import { Tooltip } from "./Tooltip";
import { UserCardTrigger } from "./UserCard";
import { GroupAvatar, GroupMembersMenu, useGroupTitle } from "./GroupDm";

/** Why writing is closed in a DM, in words (null = open). History stays readable in every case. */
const closedReason = (state: DmComposerState, name: string) =>
  state === "blocked" ? t("composer.dmBlocked", { name }) : state === "notFriend" || state === "refused" ? t("composer.dmNotFriend", { name }) : null;

/** A DM conversation on Home: the same Conversation as a channel, with the other person in the header. */
export function DmView({ dmId }: { dmId: string }) {
  const key = dmKey(dmId);
  const dm = useDms().data?.find((d) => d.id === dmId);
  const friends = useFriends();
  const blocks = useBlocks();
  const statusOf = useStatusOf();
  const nameOf = useNameOf();
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

  if (isGroup(dm)) return <GroupView dm={dm} inCall={inCall} />;
  const name = nameOf(dm.user.id, dm.user.username);
  const status = statusOf(dm.user.id);
  const state = dmComposerState({ friends: friends.data, friendsUpdatedAt: friends.dataUpdatedAt, blocked, otherId: dm.user.id, forbiddenAt });
  return (
    <Conversation
      convKey={key}
      header={
        <>
          <UserCardTrigger user={dm.user} guildId={null} decorative>
            <PresenceAvatar id={dm.user.id} name={name} status={status} ring={2} labelled={false} className="size-8 rounded-full text-xs" />
          </UserCardTrigger>
          <h1 className="min-w-0 truncate">
            <UserCardTrigger user={dm.user} guildId={null} className="max-w-full truncate hover:underline">
              {name}
            </UserCardTrigger>
          </h1>
          <span className="shrink-0 text-xs font-normal text-ink-muted">{statusLabel(status)}</span>
        </>
      }
      actions={<CallButtons dmId={dmId} name={name} open={state === "ok"} inCall={inCall} />}
      banner={inCall && <CallStreams />}
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

/** Voice and video call buttons of a DM header (a group call rings every other participant). */
function CallButtons({ dmId, name, open, inCall }: { dmId: string; name: string; open: boolean; inCall: boolean }) {
  return (
    <>
      {[false, true].map((video) => (
        <Tooltip key={String(video)} label={!open ? t("call.unavailable") : inCall ? t("call.inCall") : video ? t("call.video") : t("call.voice")}>
          <span className="inline-flex">
            <button
              type="button"
              aria-label={video ? t("call.video") : t("call.voice")}
              disabled={!open || inCall}
              onClick={() => void calls.start(dmId, name, video)}
              className="grid size-10 place-items-center rounded-control text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-4 hover:text-ink active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
            >
              {video ? <VideoCamera aria-hidden="true" /> : <Phone aria-hidden="true" />}
            </button>
          </span>
        </Tooltip>
      ))}
    </>
  );
}

/** A group DM: any participant may write and call; members, add / leave / remove live in the header menu. */
function GroupView({ dm, inCall }: { dm: GroupDm; inCall: boolean }) {
  const name = useGroupTitle(dm);
  return (
    <Conversation
      convKey={dmKey(dm.id)}
      header={
        <>
          <GroupAvatar g={dm} />
          <h1 className="min-w-0 truncate">{name}</h1>
          <span className="numeric shrink-0 text-xs font-normal text-ink-muted">{t("group.memberCount", { count: String(dm.participants.length) })}</span>
        </>
      }
      actions={
        <>
          <CallButtons dmId={dm.id} name={name} open inCall={inCall} />
          <GroupMembersMenu g={dm} />
        </>
      }
      banner={inCall && <CallStreams />}
      logLabel={t("dm.log", { name })}
      start={{ icon: <ChatsCircle size={24} />, title: t("group.startTitle", { name  }), body: t("group.startBody"), emptyTitle: t("group.startTitle", { name  }), emptyBody: t("dm.emptyBody") }}
      canManage={false}
      composer={{ label: t("dm.composerLabel", { name }), placeholder: t("dm.placeholder", { name }), ready: true, closedReason: null }}
    />
  );
}
