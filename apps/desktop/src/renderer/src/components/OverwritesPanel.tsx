import { CHANNEL_PERMISSIONS, hasPermission, Permission } from "@loop/shared";
import { Check, X } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";
import { callerChannelBits, canManageRole, CHANNEL_BITS, grantableBits, previewPermissions, setTri, triOf, type SettingsCtx, type Tri } from "../lib/admin";
import { admin } from "../lib/app";
import { errorMessage } from "../lib/errors";
import { useNav } from "../lib/nav";
import type { Channel, Role } from "../lib/permissions";
import { Banner } from "./Banner";
import { Button } from "./Button";

const TRI: [Tri, MessageKey, string][] = [
  ["allow", "overwrites.allow", "peer-checked:bg-moss-900 peer-checked:text-moss-200 peer-checked:border-moss-300"],
  ["inherit", "overwrites.inherit", "peer-checked:bg-surface-4 peer-checked:text-ink peer-checked:border-line-strong"],
  ["deny", "overwrites.deny", "peer-checked:bg-danger-bg peer-checked:text-danger peer-checked:border-danger"],
];

export function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-11 w-full min-w-0 truncate rounded-control border border-line-strong bg-surface-3 px-3 text-[15px] text-ink">
        {children}
      </select>
    </div>
  );
}

/** Per channel and role: allow / default / deny for each channel bit, with a live preview of the outcome. */
export function OverwritesPanel({ ctx }: { ctx: SettingsCtx }) {
  const navChannel = useNav((s) => s.channelId);
  const [channelId, setChannelId] = useState(() => (ctx.channels.some((c) => c.id === navChannel) ? navChannel! : ctx.channels[0]?.id ?? ""));
  const roles = [...ctx.roles].filter((r) => canManageRole(ctx.standing, r)).sort((a, b) => b.position - a.position);
  const [roleId, setRoleId] = useState(() => roles.find((r) => r.id !== ctx.guildId)?.id ?? roles[0]?.id ?? "");
  const channel = ctx.channels.find((c) => c.id === channelId);
  const role = roles.find((r) => r.id === roleId);

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="text-sm leading-relaxed text-ink-muted">{t("overwrites.explain")}</p>
      {!channel || !role ? (
        <Banner tone="warning">{t(roles.length === 0 ? "overwrites.noRoles" : "overwrites.noChannels")}</Banner>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <Select label={t("overwrites.channel")} value={channelId} onChange={setChannelId}>
              {ctx.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.type === "VOICE" ? t("overwrites.voiceChannel", { name: c.name }) : `# ${c.name}`}
                </option>
              ))}
            </Select>
            <Select label={t("overwrites.role")} value={roleId} onChange={setRoleId}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </div>
          <OverwriteEditor key={`${channel.id}:${role.id}`} ctx={ctx} channel={channel} role={role} />
        </>
      )}
    </div>
  );
}

function OverwriteEditor({ ctx, channel, role }: { ctx: SettingsCtx; channel: Channel; role: Role }) {
  const existing = channel.overwrites.find((o) => o.roleId === role.id) ?? { allow: 0, deny: 0 };
  const [draft, setDraft] = useState({ allow: existing.allow, deny: existing.deny });
  const [saved, setSaved] = useState(false);
  const held = grantableBits(callerChannelBits(ctx, channel), CHANNEL_PERMISSIONS);
  const changed = draft.allow !== existing.allow || draft.deny !== existing.deny;
  const empty = draft.allow === 0 && draft.deny === 0;
  const preview = previewPermissions(ctx.roles, ctx.guildId, role.id, channel.overwrites, draft);

  const save = useMutation({
    mutationFn: () => (empty ? admin.clearOverwrite(ctx.guildId, channel.id, role.id) : admin.setOverwrite(ctx.guildId, channel.id, role.id, draft)),
    onSuccess: () => setSaved(true),
  });
  const edit = (next: typeof draft) => {
    setSaved(false);
    save.reset();
    setDraft(next);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && !save.isPending) save.mutate();
      }}
      className="flex flex-col gap-3"
    >
      <ul className="flex flex-col gap-2">
        {CHANNEL_BITS.map((item) => {
          const bit = Permission[item.name];
          const locked = !(held & bit);
          return (
            <li key={item.name} className="rounded-control border border-line p-3" title={locked ? t("overwrites.notHeld") : undefined}>
              <p id={`ow-${item.name}`} className="text-[15px] font-medium">
                {t(item.label)}
              </p>
              <p className="mb-2 text-[13px] text-ink-muted">{t(item.desc)}</p>
              <div role="radiogroup" aria-labelledby={`ow-${item.name}`} className="flex flex-wrap gap-1.5">
                {TRI.map(([value, label, on]) => (
                  <label key={value} className={`relative ${locked ? "opacity-60" : "cursor-pointer"}`}>
                    <input
                      type="radio"
                      name={`ow-${item.name}`}
                      value={value}
                      checked={triOf(draft, bit) === value}
                      disabled={locked}
                      onChange={() => edit(setTri(draft, bit, value))}
                      className="peer sr-only"
                    />
                    <span className={`flex h-10 min-w-24 items-center justify-center rounded-control border border-line px-3 text-sm text-ink-muted peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-moss-300 ${on}`}>
                      {t(label)}
                    </span>
                  </label>
                ))}
              </div>
            </li>
          );
        })}
      </ul>

      <section aria-label={t("overwrites.preview")} className="rounded-control border border-line p-3">
        <p className="text-sm font-medium">{t("overwrites.preview")}</p>
        <p className="mb-2 text-[13px] text-ink-muted [overflow-wrap:anywhere]">{t("overwrites.previewBody", { role: role.name })}</p>
        <ul className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {CHANNEL_BITS.map((item) => {
            const yes = hasPermission(preview, Permission[item.name]);
            return (
              <li key={item.name} data-bit={item.name} data-allowed={yes} className={`flex min-w-0 items-center gap-2 text-sm ${yes ? "text-moss-300" : "text-danger"}`}>
                {yes ? <Check aria-hidden="true" className="shrink-0" /> : <X aria-hidden="true" className="shrink-0" />}
                <span className="min-w-0 truncate">{t(item.label)}</span>
                <span className="sr-only">{yes ? t("overwrites.yes") : t("overwrites.no")}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <div aria-live="polite" className="empty:hidden">
        {save.isError && <Banner tone="danger">{errorMessage(save.error)}</Banner>}
        {saved && !save.isError && <p className="text-sm font-medium text-moss-300">{t("overwrites.saved")}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={save.isPending} disabled={!changed}>
          {t("overwrites.save")}
        </Button>
        <Button type="button" variant="ghost" disabled={empty} onClick={() => edit({ allow: 0, deny: 0 })}>
          {t("overwrites.reset")}
        </Button>
      </div>
    </form>
  );
}
