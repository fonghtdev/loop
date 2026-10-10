import { Permission } from "@loop/shared";
import { CaretLeft, Lock, Plus } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "../i18n/t";
import { canManageRole, grantableBits, patchRole, PERMISSION_GROUPS, roleNameError, setBit, unknownBits, type SettingsCtx } from "../lib/admin";
import { admin } from "../lib/app";
import { errorMessage } from "../lib/errors";
import type { Role } from "../lib/permissions";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { ConfirmBody } from "./Confirm";
import { Dialog } from "./Dialog";
import { TextField } from "./TextField";

/** Roles, most powerful first, @everyone last; click one to edit. No reordering: the server has no endpoint for it. */
export function RolesPanel({ ctx }: { ctx: SettingsCtx }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const { standing, guildId } = ctx;
  const roles = [...ctx.roles].sort((a, b) => b.position - a.position);
  const role = roles.find((r) => r.id === editing);
  if (editing === "new" || role) return <RoleEditor key={editing} ctx={ctx} role={role ?? null} onBack={() => setEditing(null)} />;

  const canCreate = standing.isOwner || standing.top >= 1; // server: a caller with only @everyone cannot create roles
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-ink-muted">{t("roles.intro")}</p>
        <Button type="button" onClick={() => setEditing("new")} disabled={!canCreate} title={canCreate ? undefined : t("roles.createNeedsRole")}>
          <Plus aria-hidden="true" />
          {t("roles.create")}
        </Button>
      </div>
      <ul aria-label={t("roles.list")} className="flex flex-col gap-1">
        {roles.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => setEditing(r.id)}
              className="flex min-h-11 w-full items-center gap-3 rounded-control border border-line px-3 text-left hover:bg-surface-3"
            >
              <span className={`min-w-0 flex-1 truncate ${r.id === guildId ? "text-ink-muted italic" : "font-medium"}`} title={r.name}>
                {r.name}
              </span>
              {r.id === guildId && <span className="shrink-0 text-xs text-ink-muted">{t("roles.everyoneTag")}</span>}
              {!canManageRole(standing, r) && (
                <span className="shrink-0 text-ink-muted" title={t("roles.readOnly")}>
                  <Lock aria-hidden="true" size={16} />
                  <span className="sr-only">{t("roles.readOnly")}</span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RoleEditor({ ctx, role, onBack }: { ctx: SettingsCtx; role: Role | null; onBack: () => void }) {
  const { standing, guildId } = ctx;
  const isEveryone = role?.id === guildId;
  const editable = role ? canManageRole(standing, role) : true;
  const [name, setName] = useState(role?.name ?? "");
  const [permissions, setPermissions] = useState(role?.permissions ?? 0);
  const [tried, setTried] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saved, setSaved] = useState(false);
  const held = grantableBits(standing.bits);
  const patch = role ? patchRole(role, { name, permissions }) : null;
  const nameError = isEveryone ? undefined : roleNameError(name);

  const save = useMutation({
    mutationFn: async () => {
      if (!role) await admin.createRole(guildId, { name: name.trim(), permissions });
      else if (patch) await admin.updateRole(guildId, role.id, patch);
    },
    onSuccess: () => (role ? setSaved(true) : onBack()),
  });
  const change = (fn: () => void) => {
    setSaved(false);
    save.reset();
    fn();
  };
  const submit = () => {
    setTried(true);
    if (!nameError && !save.isPending) save.mutate();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
      className="flex max-w-2xl flex-col gap-4"
    >
      <div>
        <Button type="button" variant="ghost" onClick={onBack} className="-ml-2">
          <CaretLeft aria-hidden="true" />
          {t("roles.back")}
        </Button>
      </div>
      <h2 className="font-display text-lg font-bold break-words">{role ? role.name : t("roles.new")}</h2>
      {!editable && <Banner tone="warning">{t("roles.readOnlyBody")}</Banner>}
      {isEveryone && <p className="text-sm text-ink-muted">{t("roles.everyoneBody")}</p>}
      {!isEveryone && (
        <TextField
          label={t("roles.name")}
          maxLength={100}
          value={name}
          disabled={!editable}
          onChange={(e) => change(() => setName(e.target.value))}
          error={tried ? nameError : undefined}
        />
      )}
      {PERMISSION_GROUPS.map((group) => (
        <fieldset key={group.title} className="flex min-w-0 flex-col gap-1 rounded-panel border border-line p-2">
          <legend className="px-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">{t(group.title)}</legend>
          {group.items.map((item) => {
            const bit = Permission[item.name];
            const locked = !editable || !(held & bit);
            return (
              <label
                key={item.name}
                title={editable && locked ? t("roles.bitNotHeld") : undefined}
                className={`flex min-h-11 items-start gap-3 rounded-control px-2 py-2 ${locked ? "opacity-70" : "cursor-pointer hover:bg-surface-3"}`}
              >
                <input
                  type="checkbox"
                  checked={!!(permissions & bit)}
                  disabled={locked}
                  onChange={(e) => change(() => setPermissions(setBit(permissions, bit, e.target.checked)))}
                  className="mt-0.5 size-5 shrink-0 accent-moss-400"
                />
                <span className="min-w-0">
                  <span className="block text-[15px] font-medium">{t(item.label)}</span>
                  <span className="block text-[13px] text-ink-muted">{t(item.desc)}</span>
                  {item.name === "ADMINISTRATOR" && <span className="mt-1 block text-[13px] font-medium text-warning">{t("perm.ADMINISTRATOR.warning")}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
      {unknownBits(permissions) !== 0 && <p className="text-[13px] text-ink-muted">{t("roles.unknownBits", { bits: String(unknownBits(permissions)) })}</p>}
      <div aria-live="polite" className="empty:hidden">
        {save.isError && <Banner tone="danger">{errorMessage(save.error)}</Banner>}
        {saved && !save.isError && <p className="text-sm font-medium text-moss-300">{t("roles.saved")}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {editable && (
          <Button type="submit" loading={save.isPending} disabled={!!role && !patch}>
            {role ? t("roles.save") : t("roles.createSubmit")}
          </Button>
        )}
        {role && !isEveryone && editable && (
          <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)} className="text-danger!">
            {t("roles.delete")}
          </Button>
        )}
      </div>
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t("roles.deleteTitle", { name: role?.name ?? "" })}>
        {role && (
          <ConfirmBody
            body={t("roles.deleteBody")}
            submit={t("roles.delete")}
            onDone={() => setConfirmDelete(false)}
            action={async () => {
              await admin.deleteRole(guildId, role.id);
              onBack();
            }}
          />
        )}
      </Dialog>
    </form>
  );
}
