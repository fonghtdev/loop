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
  if (status === 409) return t("errors.taken");
  if (status === 429) return t("errors.rateLimited");
  if (status >= 500) return t("errors.server");
  return t("errors.unknown");
}
