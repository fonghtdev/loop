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
import { toast } from "../lib/toast";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { Segmented, type SegmentOption } from "./Segmented";

const TRI: SegmentOption<Tri>[] = [
  { value: "allow", label: "", thumb: "bg-moss-900", on: "peer-checked:text-moss-200" },
  { value: "inherit", label: "", thumb: "bg-surface-4", on: "peer-checked:text-ink" },
  { value: "deny", label: "", thumb: "bg-danger-bg", on: "peer-checked:text-danger" },
];
const TRI_LABEL: Record<Tri, MessageKey> = { allow: "overwrites.allow", inherit: "overwrites.inherit", deny: "overwrites.deny" };

export function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-11 w-full min-w-0 truncate rounded-control border border-line-strong bg-surface-3 px-3 text-chat text-ink">
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
  const held = grantableBits(callerChannelBits(ctx, channel), CHANNEL_PERMISSIONS);
  const changed = draft.allow !== existing.allow || draft.deny !== existing.deny;
  const empty = draft.allow === 0 && draft.deny === 0;
  const preview = previewPermissions(ctx.roles, ctx.guildId, role.id, channel.overwrites, draft);

  const save = useMutation({
    mutationFn: () => (empty ? admin.clearOverwrite(ctx.guildId, channel.id, role.id) : admin.setOverwrite(ctx.guildId, channel.id, role.id, draft)),
    onSuccess: () => toast.push(t("overwrites.saved")),
  });
  const edit = (next: typeof draft) => {
    save.reset();
    toast.dismiss(); // "saved" is no longer true of what is on screen
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
      <ul className="relative edge flex flex-col rounded-panel bg-raise p-2 shadow-e2">
        {CHANNEL_BITS.map((item) => {
          const bit = Permission[item.name];
          const locked = !(held & bit);
          return (
            <li key={item.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-control px-3 py-2.5">
              <div className="min-w-0 flex-1 basis-56">
                <p id={`ow-${item.name}`} className="text-chat font-medium">
                  {t(item.label)}
                </p>
                <p className="text-small text-ink-muted">{t(item.desc)}</p>
                {locked && <p className="text-small text-ink-muted">{t("overwrites.notHeld")}</p>}
              </div>
              <Segmented
                radiogroup
                labelledBy={`ow-${item.name}`}
                name={`ow-${item.name}`}
                value={triOf(draft, bit)}
                disabled={locked}
                onChange={(v) => edit(setTri(draft, bit, v))}
                options={TRI.map((o) => ({ ...o, label: t(TRI_LABEL[o.value]) }))}
              />
            </li>
          );
        })}
      </ul>

      <section aria-label={t("overwrites.preview")} className="relative edge rounded-panel bg-raise p-4 shadow-e2">
        <p className="text-sm font-medium">{t("overwrites.preview")}</p>
        <p className="mb-2 text-small text-ink-muted [overflow-wrap:anywhere]">{t("overwrites.previewBody", { role: role.name })}</p>
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
