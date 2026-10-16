import { hasPermission } from "@loop/shared";
import { useQuery } from "@tanstack/react-query";
import { standingFor } from "./admin";
import { presence, session } from "./app";
import { profiles } from "./profiles";
import { BLOCKS_KEY, DMS_KEY, dmPeople, FRIENDS_KEY, type Dm, type FriendsData, type PublicUser } from "./social";
import { permissionsFor, type Channel, type Guild, type Member, type Role } from "./permissions";
import type { GuildData } from "./categories";

const api = session.client.request;

// Every key of one guild starts with ["guild", id], so `revalidateGuild` refreshes them all at once.
export const useGuilds = () => useQuery({ queryKey: ["guilds"], queryFn: () => api<Guild[]>("GET", "/guilds") });

export const guildQuery = (guildId: string | null) => ({
  queryKey: ["guild", guildId],
  queryFn: () => api<GuildData>("GET", `/guilds/${guildId}`),
});

export const useGuild = (guildId: string | null) => useQuery({ ...guildQuery(guildId), enabled: !!guildId });

export const useMembers = (guildId: string | null) =>
  useQuery({ queryKey: ["guild", guildId, "members"], queryFn: () => api<Member[]>("GET", `/guilds/${guildId}/members`).then((l) => presence.seed(l.map((m) => ({ id: m.userId, status: m.status })), l)).then((l) => profiles.seed(l.map((m) => ({ ...m, id: m.userId })), l)), enabled: !!guildId });

export const useRoles = (guildId: string | null) =>
  useQuery({ queryKey: ["guild", guildId, "roles"], queryFn: () => api<Role[]>("GET", `/guilds/${guildId}/roles`), enabled: !!guildId });

/**
 * THE permission check of the UI: the user's bits in the guild (or in `channelId`), from data the server already
 * serves. Until everything is loaded (or for a channel we cannot see) every check is false: hidden/disabled.
 * The server stays the authority; actions still handle 403/404.
 */
export function usePermissions(guildId: string | null, channelId?: string | null) {
  const userId = session.useSession((s) => s.user?.id);
  const guild = useGuild(guildId).data;
  const members = useMembers(guildId).data;
  const roles = useRoles(guildId).data;
  if (!userId || !guild || !members || !roles) return { ready: false, can: () => false, bits: 0, bitsIn: () => 0, standing: null };
  const data = { userId, guild: guild.guild, members, roles };
  const channel = channelId ? guild.channels.find((c) => c.id === channelId) : undefined;
  const bits = channelId && !channel ? 0 : permissionsFor(data, channel);
  return { ready: true, can: (perm: number) => hasPermission(bits, perm), bits, bitsIn: (c: Pick<Channel, "overwrites" | "memberOverwrites">) => permissionsFor(data, c), standing: standingFor(data) };
}

// Friends, DMs and blocks: kept live in place by the socket events (lib/social.ts); refetched after a reconnect.
export const useFriends = () => useQuery({ queryKey: FRIENDS_KEY, queryFn: () => api<FriendsData>("GET", "/friends").then((d) => presence.seed(d.friends, d)).then((d) => profiles.seed([...d.friends, ...d.incoming, ...d.outgoing], d)) });
export const useBlocks = () => useQuery({ queryKey: BLOCKS_KEY, queryFn: () => api<PublicUser[]>("GET", "/blocks").then((l) => profiles.seed(l, l)) });
export const useDms = () => useQuery({ queryKey: DMS_KEY, queryFn: () => api<Dm[]>("GET", "/dms").then((l) => presence.seed(l.flatMap(dmPeople), l)).then((l) => profiles.seed(l.flatMap(dmPeople), l)) });
