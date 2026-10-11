import { Gear, X } from "@phosphor-icons/react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";
import { guardSettings, settingsSections, type SettingsCtx, type SettingsTab } from "../lib/admin";
import { errorMessage } from "../lib/errors";
import { useNav } from "../lib/nav";
import { useGuild, useMembers, usePermissions, useRoles } from "../lib/queries";
import { useTabIndicator } from "../lib/tabs-hooks";
import { DangerPanel } from "./DangerPanel";
import { MembersPanel } from "./MembersPanel";
import { OverwritesPanel } from "./OverwritesPanel";
import { RolesPanel } from "./RolesPanel";
import { LoadError, Skeleton } from "./States";
import { Tooltip } from "./Tooltip";

const TAB_LABELS: Record<SettingsTab, MessageKey> = {
  roles: "settings.tab.roles",
  members: "settings.tab.members",
  overwrites: "settings.tab.overwrites",
  danger: "settings.tab.danger",
};

/**
 * The server settings view (main area, solid). Which tabs exist, and whether the view may stay open at all, is
 * decided here from the user's CURRENT rights (also for a restored place and after an ownership change).
 */
export function ServerSettings({ guildId }: { guildId: string }) {
  const guild = useGuild(guildId);
  const roles = useRoles(guildId);
  const members = useMembers(guildId);
  const perms = usePermissions(guildId);
  const requested = useNav((s) => (s.settings === "user" ? null : s.settings));
  const sections = settingsSections(perms.bits, perms.standing?.isOwner ?? false);
  const tab = perms.ready ? guardSettings(requested, sections) : requested;
  const heading = useRef<HTMLHeadingElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  useTabIndicator(tabList, indicator, tab ?? "", sections.join());

  useEffect(() => {
    if (perms.ready && tab !== requested) useNav.setState({ settings: tab });
  }, [perms.ready, tab, requested]);

  // focus moves into the view when it opens and back to the server menu when it closes
  useEffect(() => {
    heading.current?.focus();
    return () => {
      if (document.activeElement === document.body) document.querySelector<HTMLElement>('[popovertarget="guild-menu"]')?.focus();
    };
  }, []);

  const queries = [guild, roles, members];
  const failed = queries.find((q) => q.isError);
  const ctx: SettingsCtx | null =
    perms.standing && guild.data && roles.data && members.data
      ? { guildId, guildName: guild.data.guild.name, ownerId: guild.data.guild.ownerId, standing: perms.standing, roles: roles.data, members: members.data, channels: guild.data.channels }
      : null;

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = sections.indexOf(tab as SettingsTab);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: sections.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = sections[(to + sections.length) % sections.length];
    useNav.setState({ settings: next });
    requestAnimationFrame(() => document.getElementById(`settings-tab-${next}`)?.focus());
  };

  return (
    <section aria-labelledby="settings-title" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-hair bg-head px-4 font-display text-[15px] font-bold shadow-[inset_0_1px_0_var(--color-highlight)]">
        <Gear aria-hidden="true" className="shrink-0 text-ink-muted" />
        <h1 id="settings-title" ref={heading} tabIndex={-1} className="min-w-0 flex-1 truncate outline-none">
          {t("settings.title", { name: guild.data?.guild.name ?? "" })}
        </h1>
        <Tooltip label={t("settings.close")}>
          <button type="button" onClick={() => useNav.setState({ settings: null })} aria-label={t("settings.close")} className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink active:scale-[.98]">
            <X aria-hidden="true" />
          </button>
        </Tooltip>
      </header>
      {tab && (
        <div ref={tabList} role="tablist" aria-label={t("settings.tabs")} onKeyDown={move} className="relative flex shrink-0 gap-1 overflow-x-auto border-b border-hair px-4 [scrollbar-width:none]">
          {sections.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              id={`settings-tab-${s}`}
              aria-selected={s === tab}
              aria-controls="settings-panel"
              tabIndex={s === tab ? 0 : -1}
              onClick={() => useNav.setState({ settings: s })}
              className={`h-12 rounded-t-control px-4 text-ui font-semibold whitespace-nowrap transition-colors duration-(--duration-fast) ${s === tab ? "text-ink" : "text-ink-muted hover:bg-white/[.045] hover:text-ink"} ${s === "danger" ? "text-danger!" : ""}`}
            >
              {t(TAB_LABELS[s])}
            </button>
          ))}
          <span
            ref={indicator}
            aria-hidden="true"
            data-tab-indicator
            style={{ transform: "translateX(0) scaleX(0)" }}
            className="pointer-events-none absolute bottom-[-1px] left-0 h-0.5 w-[100px] origin-left rounded-t-xs bg-cosmic shadow-[0_0_12px_var(--color-cosmic-glow)]"
          />
        </div>
      )}
      <div id="settings-panel" role="tabpanel" aria-labelledby={tab ? `settings-tab-${tab}` : undefined} className="min-h-0 flex-1 overflow-y-auto p-4">
        {failed && <LoadError message={errorMessage(failed.error)} onRetry={() => queries.forEach((q) => void q.refetch())} />}
        {!failed && (!ctx || !tab) && <Skeleton rows={6} />}
        {ctx && tab === "roles" && <RolesPanel ctx={ctx} />}
        {ctx && tab === "members" && <MembersPanel ctx={ctx} />}
        {ctx && tab === "overwrites" && <OverwritesPanel ctx={ctx} />}
        {ctx && tab === "danger" && <DangerPanel ctx={ctx} />}
      </div>
    </section>
  );
}
