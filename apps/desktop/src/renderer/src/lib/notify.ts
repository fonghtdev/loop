import type { StatusPref } from "@loop/shared";
import type { NotifyPayload } from "../../../shared/notify";
import type { Settings } from "../../../shared/settings";
import { t } from "../i18n/t";
import type { Message } from "./chat";
import { channelKey, dmKey, parseKey, type ConvKey } from "./conversation";
import { readable } from "./mentions";

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
  /** The message names me (or is a permitted @everyone / @here). */
  mentioned: boolean;
};

/**
 * Whether the OS should be told. DMs and calls, and a guild channel only for a message that mentions me (an ordinary
 * channel message never notifies); not when notifications are off, do-not-disturb, for our own messages, for blocked
 * people, or when the user is looking right at that conversation.
 */
export function shouldNotify(d: NotifyDecision): boolean {
  if (parseKey(d.conversation).kind !== "dm" && !(d.kind === "message" && d.mentioned)) return false;
  if (!d.settings.notifications || d.myStatus === "dnd" || d.isOwn || d.blocked) return false;
  return !(d.windowFocused && d.openConversation === d.conversation);
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * A DM or channel message as a notification: the sender's name and the text (or "sent a file"), `<@id>` read as
 * `@name`; the main process redacts for no-preview.
 */
export function messageNotice(m: Message, nameOf: (id: string) => string | undefined = () => undefined): NotifyPayload {
  return {
    conversationKey: m.dmChannelId ? dmKey(m.dmChannelId) : channelKey(m.channelId ?? ""),
    title: oneLine(m.author.username, 80),
    body: oneLine(readable(m.content, nameOf), 200) || t("notify.file"),
    kind: "message",
  };
}

export function callNotice(dmId: string, name: string, video: boolean): NotifyPayload {
  return { conversationKey: `call:${dmId}`, title: oneLine(name, 80), body: t(video ? "notify.videoCall" : "notify.call"), kind: video ? "video-call" : "call" };
}
