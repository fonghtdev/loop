/**
 * The message store holds one list per conversation, a guild channel or a DM. The prefix keeps the two apart
 * even though both are plain uuids (and the REST path, socket events and subscription differ by kind).
 */
export type ConvKey = `channel:${string}` | `dm:${string}`;

export const channelKey = (id: string): ConvKey => `channel:${id}`;
export const dmKey = (id: string): ConvKey => `dm:${id}`;

export function parseKey(key: ConvKey): { kind: "channel" | "dm"; id: string } {
  return key.startsWith("dm:") ? { kind: "dm", id: key.slice(3) } : { kind: "channel", id: key.slice(8) };
}

/** History and send path of a conversation. */
export function messagesPath(key: ConvKey): string {
  const { kind, id } = parseKey(key);
  return kind === "dm" ? `/dms/${id}/messages` : `/channels/${id}/messages`;
}

/** Where an attachment upload is bound: exactly one of the two. */
export function uploadTarget(key: ConvKey): { channelId: string } | { dmChannelId: string } {
  const { kind, id } = parseKey(key);
  return kind === "dm" ? { dmChannelId: id } : { channelId: id };
}
