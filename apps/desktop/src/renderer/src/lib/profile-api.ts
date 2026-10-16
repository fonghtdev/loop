import type { UserUpdatedEvent } from "@loop/shared";
import type { Method } from "./auth-client";
import type { ImageUploader } from "./image-upload";
import type { ProfileFields } from "./profile-form";

type Request = <T>(method: Method, path: string, body?: unknown) => Promise<T>;

/** What `GET /users/:id/profile` and `PATCH /me/profile` answer. */
export type UserProfile = ProfileFields & { id: string; username: string; avatarHash: string | null; bannerHash: string | null; createdAt: string };

export const profileKey = (userId: string) => ["profile", userId] as const;

/**
 * The calls of the user's own profile. Every change that succeeds is handed to `changed` with the new public fields (the
 * server also pushes `user:updated`, to every device and to others, but the editor should not wait for it).
 */
export function createProfileApi({ request, upload, changed }: { request: Request; upload: ImageUploader; changed: (e: Pick<UserUpdatedEvent, "id" | "displayName" | "avatarHash" | "bannerHash" | "statusText">) => void }) {
  const publish = (p: UserProfile) => {
    changed({ id: p.id, displayName: p.displayName, avatarHash: p.avatarHash, bannerHash: p.bannerHash, statusText: p.statusText });
    return p;
  };
  return {
    get: (userId: string) => request<UserProfile>("GET", `/users/${userId}/profile`),
    update: async (patch: Partial<ProfileFields>) => publish(await request<UserProfile>("PATCH", "/me/profile", patch)),
    /** Uploads the picture, then reads the profile back so every public field is current. */
    async setImage(kind: "avatar" | "banner", file: File, selfId: string, onProgress?: (fraction: number) => void) {
      await upload({ base: `/me/${kind}`, kind, file, onProgress });
      return publish(await request<UserProfile>("GET", `/users/${selfId}/profile`));
    },
    async removeImage(kind: "avatar" | "banner", selfId: string) {
      await request<void>("DELETE", `/me/${kind}`);
      return publish(await request<UserProfile>("GET", `/users/${selfId}/profile`));
    },
  };
}
