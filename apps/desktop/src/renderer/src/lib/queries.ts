import { hasPermission } from "@loop/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { session } from "./app";
import { BLOCKS_KEY, DMS_KEY, FRIENDS_KEY, showOnline, type Dm, type FriendsData, type PublicUser } from "./social";
import { permissionsFor, type Channel, type Guild, type Member, type Role } from "./permissions";

const api = session.client.request;

// Every key of one guild starts with ["guild", id], so `revalidateGuild` refreshes them all at once.
export const useGuilds = () => useQuery({ queryKey: ["guilds"], queryFn: () => api<Guild[]>("GET", "/guilds") });

export const useGuild = (guildId: string | null) =>
  useQuery({
    queryKey: ["guild", guildId],
    queryFn: () => api<{ guild: Guild; channels: Channel[] }>("GET", `/guilds/${guildId}`),
    enabled: !!guildId,
  });

export const useMembers = (guildId: string | null) =>
  useQuery({ queryKey: ["guild", guildId, "members"], queryFn: () => api<Member[]>("GET", `/guilds/${guildId}/members`), enabled: !!guildId });

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
  if (!userId || !guild || !members || !roles) return { ready: false, can: () => false };
  const channel = channelId ? guild.channels.find((c) => c.id === channelId) : undefined;
  const bits = channelId && !channel ? 0 : permissionsFor({ userId, guild: guild.guild, members, roles }, channel);
  return { ready: true, can: (perm: number) => hasPermission(bits, perm) };
}

// Friends, DMs and blocks: kept live in place by the socket events (lib/social.ts); refetched after a reconnect.
export const useFriends = () => useQuery({ queryKey: FRIENDS_KEY, queryFn: () => api<FriendsData>("GET", "/friends") });
export const useBlocks = () => useQuery({ queryKey: BLOCKS_KEY, queryFn: () => api<PublicUser[]>("GET", "/blocks") });
export const useDms = () => useQuery({ queryKey: DMS_KEY, queryFn: () => api<Dm[]>("GET", "/dms") });

/** Whether to show someone as online: their flag, but never for a blocked user (and not before the block list is known). */
export function useIsOnline() {
  const blocks = useBlocks();
  const ids = useMemo(() => new Set(blocks.data?.map((u) => u.id)), [blocks.data]);
  return (u: { id: string; online: boolean }) => blocks.isSuccess && showOnline(u.id, u.online, ids);
}
