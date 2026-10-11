import { voice } from "./app";
import { planOpen, roomPlace, useNav } from "./nav";
import type { Channel } from "./permissions";
import { isActive } from "./voice";

/** From the channel list and the quick switcher alike (the click is the user gesture the OS microphone prompt needs). */
export function openChannel(channel: Pick<Channel, "id" | "guildId" | "name" | "type">) {
  const { target, status } = voice.store.getState();
  const connected = target?.kind === "channel" && target.id === channel.id && isActive(status);
  const plan = planOpen(channel.type, connected);
  if (plan.navigate) useNav.setState({ guildId: channel.guildId, channelId: channel.id, dmId: null, settings: null });
  if (plan.join) void voice.joinChannel(channel.id, channel.name, channel.guildId);
}

/** "Mở phòng thoại": the room view of the session we are in. */
export function openVoiceRoom() {
  const place = roomPlace(voice.store.getState().target);
  if (place) useNav.setState(place);
}
