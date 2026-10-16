import type { Channel } from "./permissions";
import { t } from "../i18n/t";
import { isActive, type Voice } from "./voice";

export type MovedEvent = { channelId: string; byName: string };

/**
 * The server moved us to another voice channel (`voice:moved`): rejoin there, but only when we are in a voice channel
 * of that server right now (anything else - no session, a call, an old event - is ignored). The event for the channel we
 * are already in is ignored too, so the join this causes can never come back around as another move.
 */
export function createVoiceMoved({
  voice,
  channelsOf,
  notify,
}: {
  voice: Pick<Voice, "store" | "joinChannel">;
  /** The channels of a server (cached, else fetched); undefined when unknown. */
  channelsOf: (guildId: string) => Promise<Pick<Channel, "id" | "name" | "type">[] | undefined>;
  notify: (text: string) => void;
}) {
  const sitting = () => {
    const { target, status } = voice.store.getState();
    return target?.kind === "channel" && isActive(status) ? target : null;
  };
  return async ({ channelId, byName }: MovedEvent) => {
    const from = sitting();
    if (!from?.guildId || from.id === channelId) return;
    const dest = (await channelsOf(from.guildId))?.find((c) => c.id === channelId && c.type === "VOICE");
    if (!dest || sitting()?.id !== from.id) return; // unknown channel, or the session changed while we looked
    notify(t("voice.moved", { by: byName, channel: dest.name }));
    await voice.joinChannel(dest.id, dest.name, from.guildId);
  };
}
