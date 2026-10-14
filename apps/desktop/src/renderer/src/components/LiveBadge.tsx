import { t } from "../i18n/t";

/** Marks someone who is sharing their screen (Go Live); the same pill on the room tiles and in the channel list. */
export function LiveBadge() {
  return (
    <span className="shrink-0 rounded-control bg-danger-bg px-1.5 py-0.5 text-caption font-semibold tracking-wide text-danger">
      <span aria-hidden="true">{t("voice.live")}</span>
      <span className="sr-only">{t("voice.sharing")}</span>
    </span>
  );
}
