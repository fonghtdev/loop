/** Keys the main process and the renderer agree on: a conversation, or an incoming call (always a DM). */
const ID = "[0-9a-f-]{36}";
const CONVERSATION_KEY = new RegExp(`^(dm|channel):${ID}$`);
const NOTIFY_KEY = new RegExp(`^(dm|channel|call):${ID}$`);

export const isConversationKey = (k: unknown): k is `dm:${string}` | `channel:${string}` => typeof k === "string" && CONVERSATION_KEY.test(k);
export const isNotifyKey = (k: unknown): k is string => typeof k === "string" && NOTIFY_KEY.test(k);

/** Where a clicked notification leads: a call key opens its DM. */
export const navigateKey = (k: string) => (k.startsWith("call:") ? `dm:${k.slice(5)}` : k);

export type NotifyKind = "message" | "call" | "video-call";
export type NotifyPayload = { conversationKey: string; title: string; body: string; kind: NotifyKind };

/** Largest badge count the main process accepts (anything above is a bug in the renderer). */
export const MAX_BADGE = 99_999;
