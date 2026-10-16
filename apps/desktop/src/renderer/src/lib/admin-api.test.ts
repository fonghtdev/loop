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
  const upload = vi.fn(async (a: { base: string }) => (calls.push(`upload ${a.base}`), "hash"));
  return { api: createAdminApi({ request: request as never, upload, changed, gone }), calls, changed, gone, upload };
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
    ["renameGuild", (a: ReturnType<typeof setup>["api"]) => a.renameGuild("g", "Mới"), 'PATCH /guilds/g {"name":"Mới"}'],
    ["removeGuildIcon", (a: ReturnType<typeof setup>["api"]) => a.removeGuildIcon("g"), "DELETE /guilds/g/icon"],
    ["updateChannel", (a: ReturnType<typeof setup>["api"]) => a.updateChannel("g", "c", { name: "n", topic: null }), 'PATCH /channels/c {"name":"n","topic":null}'],
    ["transfer", (a: ReturnType<typeof setup>["api"]) => a.transfer("g", "u"), 'POST /guilds/g/transfer {"userId":"u"}'],
    ["ban", (a: ReturnType<typeof setup>["api"]) => a.ban("g", "u", { reason: "spam", deleteMessageHours: 24 }), 'PUT /guilds/g/bans/u {"reason":"spam","deleteMessageHours":24}'],
    ["unban", (a: ReturnType<typeof setup>["api"]) => a.unban("g", "u"), "DELETE /guilds/g/bans/u"],
    ["revokeInvite", (a: ReturnType<typeof setup>["api"]) => a.revokeInvite("g", "a/b"), "DELETE /guilds/g/invites/a%2Fb"],
    ["reorderRoles", (a: ReturnType<typeof setup>["api"]) => a.reorderRoles("g", ["r1", "r2"]), 'PUT /guilds/g/roles/order {"roleIds":["r1","r2"]}'],
    ["setMemberOverwrite", (a: ReturnType<typeof setup>["api"]) => a.setMemberOverwrite("g", "c", "u", { allow: 0, deny: 1 }), 'PUT /channels/c/overwrites/members/u {"allow":0,"deny":1}'],
    ["clearMemberOverwrite", (a: ReturnType<typeof setup>["api"]) => a.clearMemberOverwrite("g", "c", "u"), "DELETE /channels/c/overwrites/members/u"],
  ])("%s hits the right endpoint, then refreshes the guild's roles, members and channels", async (_name, act, expected) => {
    const { api, calls } = setup();
    await act(api);
    expect(calls).toEqual([expected, "changed g"]);
  });

  it("the ban and invite lists are plain reads (no refetch)", async () => {
    const { api, calls } = setup();
    await api.listBans("g").catch(() => {});
    await api.listInvites("g").catch(() => {});
    expect(calls).toEqual(["GET /guilds/g/bans", "GET /guilds/g/invites"]);
  });

  it("moveMember posts the user to the DESTINATION channel and changes no guild data (no refetch)", async () => {
    const { api, calls } = setup();
    await api.moveMember("dest", "u");
    expect(calls).toEqual(['POST /channels/dest/voice/move {"userId":"u"}']);
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

describe("server icon upload", () => {
  it("uploads to the guild's icon base, then refreshes the guild", async () => {
    const { api, calls } = setup();
    await expect(api.setGuildIcon("g", new File([new Uint8Array(1)], "i.png", { type: "image/png" }))).resolves.toBe("hash");
    expect(calls).toEqual(["upload /guilds/g/icon", "changed g"]);
  });
  it("refreshes the guild when the upload fails too (a 403 means our rights are stale)", async () => {
    const { api, calls, upload } = setup();
    upload.mockRejectedValueOnce(new Error("no"));
    await expect(api.setGuildIcon("g", new File([], "i.png"))).rejects.toThrow("no");
    expect(calls).toContain("changed g");
  });
});
