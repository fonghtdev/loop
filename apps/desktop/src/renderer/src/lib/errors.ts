import { t } from "../i18n/t";
import { ApiError } from "./auth-client";

/** What to tell the user about a failed call. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return t("errors.unknown");
  const { status, path } = err;
  if (status === 0) return t("errors.offline");
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
