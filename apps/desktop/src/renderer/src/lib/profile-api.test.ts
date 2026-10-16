import { describe, expect, it, vi } from "vitest";
import { createProfileApi, type UserProfile } from "./profile-api";

const profile: UserProfile = { id: "me", username: "an", displayName: "Anh", bio: null, statusText: null, avatarHash: "h2", bannerHash: null, createdAt: "" };

function setup() {
  const request = vi.fn(async (..._args: unknown[]) => profile);
  const upload = vi.fn(async () => "h2");
  const changed = vi.fn();
  return { request, upload, changed, api: createProfileApi({ request: request as never, upload, changed }) };
}

describe("profile api", () => {
  it("update PATCHes only the given fields and publishes the answer", async () => {
    const { api, request, changed } = setup();
    await api.update({ statusText: "bận" });
    expect(request).toHaveBeenCalledWith("PATCH", "/me/profile", { statusText: "bận" });
    expect(changed).toHaveBeenCalledWith({ id: "me", displayName: "Anh", avatarHash: "h2", bannerHash: null, statusText: null });
  });
  it("a new avatar goes through the avatar upload, then the profile is read back and published", async () => {
    const { api, request, upload, changed } = setup();
    const file = new File([new Uint8Array(1)], "a.png", { type: "image/png" });
    await api.setImage("avatar", file, "me");
    expect(upload).toHaveBeenCalledWith({ base: "/me/avatar", kind: "avatar", file, onProgress: undefined });
    expect(request).toHaveBeenCalledWith("GET", "/users/me/profile");
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("a failed upload publishes nothing", async () => {
    const { api, upload, changed } = setup();
    upload.mockRejectedValueOnce(new Error("no"));
    await expect(api.setImage("banner", new File([], "b.png"), "me")).rejects.toThrow("no");
    expect(changed).not.toHaveBeenCalled();
  });
  it("removing deletes the picture, then publishes the fresh profile", async () => {
    const { api, request, changed } = setup();
    await api.removeImage("banner", "me");
    expect(request.mock.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(["DELETE /me/banner", "GET /users/me/profile"]);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
