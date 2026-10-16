import { t } from "../i18n/t";
import type { PresenceStatus } from "@loop/shared";
import { useDisplayName } from "../lib/identity-hooks";
import { PresenceAvatar } from "./Avatar";

/** The button is a grid and a grid track grows to its content, so the track must be allowed to shrink for `truncate` to work. */
export const ACCOUNT_TRIGGER_SIZE = "h-12 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] px-1";

/** The accessible name and tooltip of the account button: the generic name plus the (possibly truncated) full username. */
export const accountMenuLabel = (username?: string) => (username ? `${t("shell.accountMenu")}: ${username}` : t("shell.accountMenu"));

/** Avatar, name and status of the signed-in user; both lines truncate with an ellipsis, the tooltip of the button has the full name. */
export function AccountIdentity({ id, username, dot, status }: { id: string; username: string; dot: PresenceStatus; status: string }) {
  const name = useDisplayName(id, username);
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <PresenceAvatar id={id} name={name} status={dot} ring={3} size={12} labelled={false} className="size-8 rounded-full text-xs" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui leading-tight font-semibold">{name}</span>
        <span className="block truncate text-caption leading-tight text-ink-muted">{status}</span>
      </span>
    </span>
  );
}
