import { t } from "../i18n/t";
import { ApiError } from "./auth-client";

/** What to tell the user about a failed call. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return t("errors.unknown");
  const { status, path } = err;
  if (status === 0) return t("errors.offline");
  // Adding a friend by name: an unknown name and a block (either way) are the SAME 404 and get the same words,
  // so the message can never reveal a block.
  if (path === "/friends/requests") {
    if (status === 404) return t("errors.userNotFound");
    if (status === 409) return t("errors.friendDuplicate");
    if (status === 400) return t("errors.friendSelf");
  }
  // Joining a voice channel / starting a call: each status has its own words.
  if (/^\/channels\/[^/]+\/voice\/token$/.test(path)) {
    if (status === 403) return t("voice.errors.noConnect");
    if (status === 404) return t("voice.errors.gone");
    if (status === 400) return t("voice.errors.notVoice");
    if (status === 409) return t("voice.errors.full");
  }
  if (/^\/dms\/[^/]+\/call$/.test(path)) {
    if (status === 403) return t("call.errors.notFriends");
    if (status === 404) return t("call.errors.gone");
  }
  if (status === 403 && /^\/dms\/[^/]+\/messages$/.test(path)) return t("errors.notFriends");
  if (status === 400) return t("errors.invalid");
  // A 401 from login means wrong credentials; anywhere else it means the session ended.
  if (status === 401) return path === "/auth/login" ? t("errors.wrongCredentials") : t("errors.sessionExpired");
  if (status === 403) return t("errors.forbidden");
  // Unknown, expired and used-up invites all get the server's single 404.
  if (status === 404) return path.startsWith("/invites/") ? t("errors.inviteInvalid") : t("errors.notFound");
  if (status === 409) {
    if (path === "/auth/register") return t("errors.taken");
    if (path.endsWith("/members/me")) return t("errors.ownerCannotLeave");
    if (path.endsWith("/channels")) return t("errors.channelTaken");
    return t("errors.unknown");
  }
  if (status === 429) return t("errors.rateLimited");
  if (status >= 500) return t("errors.server");
  return t("errors.unknown");
}
