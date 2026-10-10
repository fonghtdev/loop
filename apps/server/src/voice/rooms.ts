import { isUuid } from "../guilds/access.js";

/** LiveKit room names; the only place that knows their shape. */
export const voiceRoom = (channelId: string) => `voice:${channelId}`;
export const dmRoom = (dmId: string) => `dm:${dmId}`;

const idOf = (prefix: string, room: string) => {
  const id = room.startsWith(prefix) ? room.slice(prefix.length) : "";
  return isUuid(id) ? id : null;
};
export const channelIdOfRoom = (room: string) => idOf("voice:", room);
export const dmIdOfRoom = (room: string) => idOf("dm:", room);
