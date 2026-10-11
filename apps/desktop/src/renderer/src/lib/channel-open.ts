import { voice } from "./app";
import { useNav } from "./nav";
import type { Channel } from "./permissions";

/**
 * What choosing a channel does, from the channel list and the quick switcher alike: go there (the server too, when it is
 * another one) and, for a voice channel, join it - the click is the user gesture the OS microphone prompt needs.
 * A channel that has vanished in the meantime is replaced by the server's first text channel (Shell's useValidPlace).
 */
export function openChannel(channel: Pick<Channel, "id" | "guildId" | "name" | "type">) {
  useNav.setState({ guildId: channel.guildId, channelId: channel.id, dmId: null, settings: null });
  if (channel.type === "VOICE") void voice.joinChannel(channel.id, channel.name);
}
