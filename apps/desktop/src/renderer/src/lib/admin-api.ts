import type { Category, Layout } from "@loop/shared";
import type { Method } from "./auth-client";
import type { Guild, Role } from "./permissions";

type Request = <T>(method: Method, path: string, body?: unknown) => Promise<T>;

/**
 * The administration calls. After EVERY call, success or failure (a 403/404 means our picture is stale),
 * `changed(guildId)` refetches the guild's data (channels + overwrites, roles, members) and the server list, so
 * `usePermissions` and the chat UI follow. `gone` runs instead after the server itself disappeared.
 */
export function createAdminApi({ request, changed, gone }: { request: Request; changed: (guildId: string) => unknown; gone: (guildId: string) => void }) {
  async function call<T = void>(guildId: string, method: Method, path: string, body?: unknown) {
    try {
      return await request<T>(method, path, body);
    } finally {
      await changed(guildId);
    }
  }
  const member = (g: string, u: string) => `/guilds/${g}/members/${u}`;
  return {
    createRole: (g: string, body: { name: string; permissions: number }) => call<Role>(g, "POST", `/guilds/${g}/roles`, body),
    updateRole: (g: string, roleId: string, patch: { name?: string; permissions?: number }) => call<Role>(g, "PATCH", `/guilds/${g}/roles/${roleId}`, patch),
    deleteRole: (g: string, roleId: string) => call(g, "DELETE", `/guilds/${g}/roles/${roleId}`),
    assignRole: (g: string, userId: string, roleId: string) => call(g, "PUT", `${member(g, userId)}/roles/${roleId}`),
    unassignRole: (g: string, userId: string, roleId: string) => call(g, "DELETE", `${member(g, userId)}/roles/${roleId}`),
    kick: (g: string, userId: string) => call(g, "DELETE", member(g, userId)),
    setOverwrite: (g: string, channelId: string, roleId: string, body: { allow: number; deny: number }) =>
      call(g, "PUT", `/channels/${channelId}/overwrites/${roleId}`, body),
    clearOverwrite: (g: string, channelId: string, roleId: string) => call(g, "DELETE", `/channels/${channelId}/overwrites/${roleId}`),
    deleteChannel: (g: string, channelId: string) => call(g, "DELETE", `/guilds/${g}/channels/${channelId}`),
    createCategory: (g: string, name: string) => call<Category>(g, "POST", `/guilds/${g}/categories`, { name }),
    renameCategory: (g: string, categoryId: string, name: string) => call<Category>(g, "PATCH", `/guilds/${g}/categories/${categoryId}`, { name }),
    deleteCategory: (g: string, categoryId: string) => call(g, "DELETE", `/guilds/${g}/categories/${categoryId}`),
    setLayout: (g: string, layout: Layout) => call(g, "PUT", `/guilds/${g}/layout`, layout),
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
