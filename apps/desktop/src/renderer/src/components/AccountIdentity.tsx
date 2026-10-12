import { t } from "../i18n/t";
import { Avatar } from "./Avatar";

/** The button is a grid and a grid track grows to its content, so the track must be allowed to shrink for `truncate` to work. */
export const ACCOUNT_TRIGGER_SIZE = "h-12 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] px-1";

/** The accessible name and tooltip of the account button: the generic name plus the (possibly truncated) full username. */
export const accountMenuLabel = (username?: string) => (username ? `${t("shell.accountMenu")}: ${username}` : t("shell.accountMenu"));

/** Avatar, name and status of the signed-in user; both lines truncate with an ellipsis, the tooltip of the button has the full name. */
export function AccountIdentity({ id, username, status }: { id: string; username: string; status: string }) {
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <span className="relative shrink-0">
        <Avatar id={id} name={username} className="size-8 rounded-full text-xs ring-2 ring-presence-on/60" />
        <span aria-hidden="true" className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-presence-on ring-2 ring-surface-3" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui leading-tight font-semibold">{username}</span>
        <span className="block truncate text-caption leading-tight text-ink-muted">{status}</span>
      </span>
    </span>
  );
}
