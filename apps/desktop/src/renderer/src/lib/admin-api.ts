import type { AuditPage, AutoModRuleDto, BanDto, Category, InviteDto, Layout } from "@loop/shared";
import type { Method } from "./auth-client";
import type { ImageUploader } from "./image-upload";
import type { Channel, Guild, Role } from "./permissions";

type Request = <T>(method: Method, path: string, body?: unknown) => Promise<T>;

/**
 * The administration calls. After EVERY call, success or failure (a 403/404 means our picture is stale),
 * `changed(guildId)` refetches the guild's data (channels + overwrites, roles, members) and the server list, so
 * `usePermissions` and the chat UI follow. `gone` runs instead after the server itself disappeared.
 */
export function createAdminApi({ request, upload, changed, gone }: { request: Request; upload: ImageUploader; changed: (guildId: string) => unknown; gone: (guildId: string) => void }) {
  async function call<T = void>(guildId: string, method: Method, path: string, body?: unknown) {
    try {
      return await request<T>(method, path, body);
    } finally {
      await changed(guildId);
    }
  }
  const member = (g: string, u: string) => `/guilds/${g}/members/${u}`;
  return {
    renameGuild: (g: string, name: string) => call<Guild>(g, "PATCH", `/guilds/${g}`, { name }),
    /** Upload then refetch; the refetch runs on failure too (a 403 means our rights are stale). */
    async setGuildIcon(g: string, file: File, onProgress?: (fraction: number) => void) {
      try {
        return await upload({ base: `/guilds/${g}/icon`, kind: "icon", file, onProgress });
      } finally {
        await changed(g);
      }
    },
    removeGuildIcon: (g: string) => call(g, "DELETE", `/guilds/${g}/icon`),
    updateChannel: (g: string, channelId: string, patch: { name?: string; topic?: string | null }) => call<Channel>(g, "PATCH", `/channels/${channelId}`, patch),
    createRole: (g: string, body: { name: string; permissions: number; color?: string | null }) => call<Role>(g, "POST", `/guilds/${g}/roles`, body),
    updateRole: (g: string, roleId: string, patch: { name?: string; permissions?: number; color?: string | null }) => call<Role>(g, "PATCH", `/guilds/${g}/roles/${roleId}`, patch),
    deleteRole: (g: string, roleId: string) => call(g, "DELETE", `/guilds/${g}/roles/${roleId}`),
    assignRole: (g: string, userId: string, roleId: string) => call(g, "PUT", `${member(g, userId)}/roles/${roleId}`),
    unassignRole: (g: string, userId: string, roleId: string) => call(g, "DELETE", `${member(g, userId)}/roles/${roleId}`),
    kick: (g: string, userId: string) => call(g, "DELETE", member(g, userId)),
    ban: (g: string, userId: string, body: { reason: string | null; deleteMessageHours: number }) => call(g, "PUT", `/guilds/${g}/bans/${userId}`, body),
    unban: (g: string, userId: string) => call(g, "DELETE", `/guilds/${g}/bans/${userId}`),
    listBans: (g: string) => request<{ bans: BanDto[] }>("GET", `/guilds/${g}/bans`).then((r) => r.bans),
    listInvites: (g: string) => request<{ invites: InviteDto[] }>("GET", `/guilds/${g}/invites`).then((r) => r.invites),
    revokeInvite: (g: string, code: string) => call(g, "DELETE", `/guilds/${g}/invites/${encodeURIComponent(code)}`),
    /** `roleIds` = every role but @everyone, highest first (409 when the set changed meanwhile: the refetch shows the new one). */
    reorderRoles: (g: string, roleIds: string[]) => call<Role[]>(g, "PUT", `/guilds/${g}/roles/order`, { roleIds }),
    setOverwrite: (g: string, channelId: string, roleId: string, body: { allow: number; deny: number }) =>
      call(g, "PUT", `/channels/${channelId}/overwrites/${roleId}`, body),
    clearOverwrite: (g: string, channelId: string, roleId: string) => call(g, "DELETE", `/channels/${channelId}/overwrites/${roleId}`),
    setMemberOverwrite: (g: string, channelId: string, userId: string, body: { allow: number; deny: number }) =>
      call(g, "PUT", `/channels/${channelId}/overwrites/members/${userId}`, body),
    clearMemberOverwrite: (g: string, channelId: string, userId: string) => call(g, "DELETE", `/channels/${channelId}/overwrites/members/${userId}`),
    deleteChannel: (g: string, channelId: string) => call(g, "DELETE", `/guilds/${g}/channels/${channelId}`),
    createCategory: (g: string, name: string) => call<Category>(g, "POST", `/guilds/${g}/categories`, { name }),
    renameCategory: (g: string, categoryId: string, name: string) => call<Category>(g, "PATCH", `/guilds/${g}/categories/${categoryId}`, { name }),
    deleteCategory: (g: string, categoryId: string) => call(g, "DELETE", `/guilds/${g}/categories/${categoryId}`),
    setLayout: (g: string, layout: Layout) => call(g, "PUT", `/guilds/${g}/layout`, layout),
    /** `channelId` = the destination voice channel. No guild refetch: nothing about the guild's data changes. */
    moveMember: (channelId: string, userId: string) => request<void>("POST", `/channels/${channelId}/voice/move`, { userId }),
    /** Server mute / deafen of someone in that voice channel (true = muted). No guild refetch, like a move. */
    setVoiceState: (channelId: string, userId: string, body: { mute?: boolean; deafen?: boolean }) => request<void>("PUT", `/channels/${channelId}/voice/members/${userId}/state`, body),
    /** One page of the audit log (`query` from lib/audit.ts#auditQuery). */
    auditLog: (g: string, query: string) => request<AuditPage>("GET", `/guilds/${g}/audit-log?${query}`),
    listAutoMod: (g: string) => request<{ rules: AutoModRuleDto[] }>("GET", `/guilds/${g}/automod/rules`).then((r) => r.rules),
    createAutoMod: (g: string, body: { name: string; keywords: string[]; enabled: boolean }) => call<AutoModRuleDto>(g, "POST", `/guilds/${g}/automod/rules`, body),
    updateAutoMod: (g: string, ruleId: string, patch: { name?: string; keywords?: string[]; enabled?: boolean }) => call<AutoModRuleDto>(g, "PATCH", `/guilds/${g}/automod/rules/${ruleId}`, patch),
    deleteAutoMod: (g: string, ruleId: string) => call(g, "DELETE", `/guilds/${g}/automod/rules/${ruleId}`),
    transfer: (g: string, userId: string) => call<{ guild: Guild }>(g, "POST", `/guilds/${g}/transfer`, { userId }),
    async deleteGuild(g: string) {
      try {
        await request("DELETE", `/guilds/${g}`);
      } catch (e) {
        await changed(g);
        throw e;
      }
      gone(g);
    },
  };
}
