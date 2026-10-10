import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@loop/shared";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";
import type { AttState, Failure } from "./attachment-machine";
import { formatSize, type Rejection } from "./attachment-rules";

const REJECTION_KEYS: Record<Rejection, MessageKey> = {
  empty: "attachment.rejected.empty",
  tooLarge: "attachment.rejected.tooLarge",
  type: "attachment.rejected.type",
  tooMany: "attachment.rejected.tooMany",
  name: "attachment.rejected.name",
};

/** Why one picked file was refused before any upload. */
export const rejectionText = (name: string, reason: Rejection) =>
  t(REJECTION_KEYS[reason], { name, max: formatSize(MAX_ATTACHMENT_BYTES), count: String(MAX_ATTACHMENTS_PER_MESSAGE) });

const FAILURE_KEYS: Record<Failure, MessageKey> = {
  network: "attachment.failed.network",
  storage: "attachment.failed.storage",
  rejected: "attachment.failed.rejected",
  mismatch: "attachment.failed.mismatch",
  tooMany: "attachment.failed.tooMany",
  denied: "attachment.failed.denied",
  unknown: "attachment.failed.unknown",
};
export const failureText = (reason: Failure) => t(FAILURE_KEYS[reason]);

/** One line about where an upload is (the tray shows it under the file name). */
export function phaseText(s: AttState): string {
  switch (s.phase) {
    case "picked":
    case "validating":
      return t("attachment.preparing");
    case "uploading":
      return t("attachment.uploading", { percent: String(Math.round(s.progress * 100)) });
    case "completing":
      return t("attachment.checking");
    case "ready":
      return t("attachment.ready");
    case "failed":
      return failureText(s.reason);
    case "removed":
      return "";
  }
}
