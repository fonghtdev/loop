import type { StatusPref } from "@loop/shared";
import type { NotifyPayload } from "../../../shared/notify";
import type { Settings } from "../../../shared/settings";
import { t } from "../i18n/t";
import type { Message } from "./chat";
import { dmKey, parseKey, type ConvKey } from "./conversation";

export type NotifyDecision = {
  /** What happened: a message in a conversation, or an incoming call. */
  kind: "message" | "call";
  isOwn: boolean;
  windowFocused: boolean;
  /** The conversation on screen (null = none, or a settings view). */
  openConversation: ConvKey | null;
  conversation: ConvKey;
  /** The sender is someone we blocked. */
  blocked: boolean;
  settings: Pick<Settings, "notifications">;
  /** My own status choice: do-not-disturb silences the OS. */
  myStatus: StatusPref;
};

/**
 * Whether the OS should be told. Only DMs and calls (a guild channel has no mentions yet, so it never notifies); not
 * when notifications are off, for our own messages, for blocked people, or when the user is looking right at that DM.
 */
export function shouldNotify(d: NotifyDecision): boolean {
  if (parseKey(d.conversation).kind !== "dm") return false;
  if (!d.settings.notifications || d.myStatus === "dnd" || d.isOwn || d.blocked) return false;
  return !(d.windowFocused && d.openConversation === d.conversation);
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** A DM message as a notification: the sender's name and the text (or "sent a file"); the main process redacts for no-preview. */
export function messageNotice(m: Message): NotifyPayload {
  return {
    conversationKey: dmKey(m.dmChannelId ?? ""),
    title: oneLine(m.author.username, 80),
    body: oneLine(m.content, 200) || t("notify.file"),
    kind: "message",
  };
}

export function callNotice(dmId: string, name: string, video: boolean): NotifyPayload {
  return { conversationKey: `call:${dmId}`, title: oneLine(name, 80), body: t(video ? "notify.videoCall" : "notify.call"), kind: video ? "video-call" : "call" };
}
