import { hasPermission, type InviteDto, Permission } from "@loop/shared";
import type { MessageKey } from "../i18n/vi";
import type { Standing } from "./admin";

/** Creation choices of the invite dialog (server: `expiresInSeconds` 60..30 days, `maxUses` 1..1000; absent = never / unlimited). */
export const INVITE_EXPIRY: { seconds: number | null; label: MessageKey }[] = [
  { seconds: 3600, label: "invite.expiry.hour" },
  { seconds: 86_400, label: "invite.expiry.day" },
  { seconds: 604_800, label: "invite.expiry.week" },
  { seconds: null, label: "invite.expiry.never" },
];
export const INVITE_MAX_USES: (number | null)[] = [null, 1, 5, 10, 25, 100];

/** Body of POST /guilds/:id/invites: only the limits that are set. */
export const inviteBody = (expiresInSeconds: number | null, maxUses: number | null) => ({
  ...(expiresInSeconds ? { expiresInSeconds } : {}),
  ...(maxUses ? { maxUses } : {}),
});

/** Whether an invite still lets people in, as the server's join check decides it. */
export function inviteStatus(i: Pick<InviteDto, "expiresAt" | "maxUses" | "uses">, now: number): "active" | "expired" | "used" {
  if (i.expiresAt !== null && Date.parse(i.expiresAt) <= now) return "expired";
  if (i.maxUses !== null && i.uses >= i.maxUses) return "used";
  return "active";
}

/** Server rule: MANAGE_ROLES (so the owner and ADMINISTRATOR) revokes any invite, CREATE_INVITE only one's own. */
export const canRevokeInvite = (s: Standing, invite: Pick<InviteDto, "createdBy">) =>
  hasPermission(s.bits, Permission.MANAGE_ROLES) || (invite.createdBy.id === s.userId && hasPermission(s.bits, Permission.CREATE_INVITE));

/** Every invite is listed only with MANAGE_ROLES; otherwise the list is the caller's own. */
export const seesAllInvites = (s: Standing) => hasPermission(s.bits, Permission.MANAGE_ROLES);
