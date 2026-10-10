import { describe, expect, it, vi } from "vitest";
import { createAdminApi } from "./admin-api";

function setup(fail?: Error) {
  const calls: string[] = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
    if (fail) throw fail;
    return undefined;
  });
  const changed = vi.fn(async (g: string) => void calls.push(`changed ${g}`));
  const gone = vi.fn((g: string) => void calls.push(`gone ${g}`));
  return { api: createAdminApi({ request: request as never, changed, gone }), calls, changed, gone };
}

describe("administration calls and cache refresh", () => {
  it.each([
    ["createRole", (a: ReturnType<typeof setup>["api"]) => a.createRole("g", { name: "mod", permissions: 4 }), 'POST /guilds/g/roles {"name":"mod","permissions":4}'],
    ["updateRole", (a: ReturnType<typeof setup>["api"]) => a.updateRole("g", "r", { name: "x" }), 'PATCH /guilds/g/roles/r {"name":"x"}'],
    ["deleteRole", (a: ReturnType<typeof setup>["api"]) => a.deleteRole("g", "r"), "DELETE /guilds/g/roles/r"],
    ["assignRole", (a: ReturnType<typeof setup>["api"]) => a.assignRole("g", "u", "r"), "PUT /guilds/g/members/u/roles/r"],
    ["unassignRole", (a: ReturnType<typeof setup>["api"]) => a.unassignRole("g", "u", "r"), "DELETE /guilds/g/members/u/roles/r"],
    ["kick", (a: ReturnType<typeof setup>["api"]) => a.kick("g", "u"), "DELETE /guilds/g/members/u"],
    ["setOverwrite", (a: ReturnType<typeof setup>["api"]) => a.setOverwrite("g", "c", "r", { allow: 1, deny: 2 }), 'PUT /channels/c/overwrites/r {"allow":1,"deny":2}'],
    ["clearOverwrite", (a: ReturnType<typeof setup>["api"]) => a.clearOverwrite("g", "c", "r"), "DELETE /channels/c/overwrites/r"],
    ["deleteChannel", (a: ReturnType<typeof setup>["api"]) => a.deleteChannel("g", "c"), "DELETE /guilds/g/channels/c"],
    ["transfer", (a: ReturnType<typeof setup>["api"]) => a.transfer("g", "u"), 'POST /guilds/g/transfer {"userId":"u"}'],
  ])("%s hits the right endpoint, then refreshes the guild's roles, members and channels", async (_name, act, expected) => {
    const { api, calls } = setup();
    await act(api);
    expect(calls).toEqual([expected, "changed g"]);
  });

  it("a refused call (stale picture: 403/404) refreshes too, and still fails for the caller", async () => {
    const { api, calls } = setup(new Error("403"));
    await expect(api.kick("g", "u")).rejects.toThrow("403");
    expect(calls).toEqual(["DELETE /guilds/g/members/u", "changed g"]);
  });

  it("deleting the server announces it is gone (no refetch of a guild that no longer exists)", async () => {
    const { api, calls, changed, gone } = setup();
    await api.deleteGuild("g");
    expect(calls).toEqual(["DELETE /guilds/g", "gone g"]);
    expect(changed).not.toHaveBeenCalled();
    expect(gone).toHaveBeenCalledWith("g");
  });

  it("a refused server delete refreshes instead and is not 'gone'", async () => {
    const { api, gone, changed } = setup(new Error("403"));
    await expect(api.deleteGuild("g")).rejects.toThrow();
    expect(gone).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledWith("g");
  });
});
