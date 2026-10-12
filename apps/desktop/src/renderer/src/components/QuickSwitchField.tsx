import { MagnifyingGlass } from "@phosphor-icons/react";
import { t } from "../i18n/t";
import { toggleQuickSwitch } from "../lib/quick-switch-state";
import { Tooltip } from "./Tooltip";

export const shortcutLabel = () => (window.loop.platform === "darwin" ? "⌘K" : "Ctrl K");

/** The entry point of the server column: a wide search field with the shortcut shown, under the server name. */
export function QuickSwitchField() {
  return (
    <Tooltip label={t("quick.title")} kbd={shortcutLabel()}>
      <button
        type="button"
        aria-label={t("quick.title")}
        aria-keyshortcuts="Control+K Meta+K"
        onClick={toggleQuickSwitch}
        className="mx-2 mt-3 flex h-10 shrink-0 items-center gap-2 rounded-control bg-surface-3 pr-2 pl-3 text-left text-small text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink active:scale-[.98]"
      >
        <MagnifyingGlass aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("quick.title")}</span>
        <kbd className="rounded-xs bg-surface-4 px-1.5 py-0.5 text-micro font-semibold">{shortcutLabel()}</kbd>
      </button>
    </Tooltip>
  );
}
