import { Permission } from "@loop/shared";
import { CaretLeft, Lock, Plus } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "../i18n/t";
import { canManageRole, grantableBits, patchRole, PERMISSION_GROUPS, roleNameError, setBit, unknownBits, type SettingsCtx } from "../lib/admin";
import { admin } from "../lib/app";
import { errorMessage } from "../lib/errors";
import type { Role } from "../lib/permissions";
import { toast } from "../lib/toast";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { ConfirmBody } from "./Confirm";
import { Dialog } from "./Dialog";
import { Switch } from "./Switch";
import { TextField } from "./TextField";
import { Tooltip } from "./Tooltip";

/** Roles, most powerful first, @everyone last; click one to edit. No reordering: the server has no endpoint for it. */
export function RolesPanel({ ctx }: { ctx: SettingsCtx }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const { standing, guildId } = ctx;
  const roles = [...ctx.roles].sort((a, b) => b.position - a.position);
  const role = roles.find((r) => r.id === editing);
  if (editing === "new" || role) return <RoleEditor key={editing} ctx={ctx} role={role ?? null} onBack={() => setEditing(null)} />;

  const canCreate = standing.isOwner || standing.top >= 1; // server: a caller with only @everyone cannot create roles
  const create = (
    <Button type="button" onClick={() => setEditing("new")} disabled={!canCreate}>
      <Plus aria-hidden="true" />
      {t("roles.create")}
    </Button>
  );
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-ink-muted">{t("roles.intro")}</p>
        {canCreate ? (
          create
        ) : (
          <Tooltip label={t("roles.createNeedsRole")}>
            <span className="inline-flex">{create}</span>
          </Tooltip>
        )}
      </div>
      <ul aria-label={t("roles.list")} className="relative edge flex flex-col gap-0.5 rounded-panel bg-raise p-2 shadow-e2">
        {roles.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => setEditing(r.id)}
              className="flex min-h-12 w-full items-center gap-3 rounded-control px-3 text-left transition-colors duration-(--duration-fast) hover:bg-white/[.045] active:scale-[.99]"
            >
              <Tooltip label={r.name}>
                <span className={`min-w-0 flex-1 truncate ${r.id === guildId ? "text-ink-muted italic" : "font-medium"}`}>{r.name}</span>
              </Tooltip>
              {r.id === guildId && <span className="shrink-0 text-caption text-ink-muted">{t("roles.everyoneTag")}</span>}
              {!canManageRole(standing, r) && (
                <Tooltip label={t("roles.readOnly")}>
                  <span className="shrink-0 text-ink-muted">
                    <Lock aria-hidden="true" size={16} />
                    <span className="sr-only">{t("roles.readOnly")}</span>
                  </span>
                </Tooltip>
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
  const held = grantableBits(standing.bits);
  const patch = role ? patchRole(role, { name, permissions }) : null;
  const nameError = isEveryone ? undefined : roleNameError(name);

  const save = useMutation({
    mutationFn: async () => {
      if (!role) await admin.createRole(guildId, { name: name.trim(), permissions });
      else if (patch) await admin.updateRole(guildId, role.id, patch);
    },
    onSuccess: () => (role ? toast.push(t("roles.saved")) : onBack()),
  });
  const change = (fn: () => void) => {
    save.reset();
    toast.dismiss(); // "saved" is no longer true of what is on screen
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
        <fieldset key={group.title} className="relative edge flex min-w-0 flex-col rounded-panel bg-raise p-2 shadow-e2">
          <legend className="sr-only">{t(group.title)}</legend>
          <p aria-hidden="true" className="px-3 pt-2 pb-1 font-display text-small font-bold tracking-wide text-ink-muted uppercase">
            {t(group.title)}
          </p>
          {group.items.map((item) => {
            const bit = Permission[item.name];
            const locked = !editable || !(held & bit);
            return (
              <Switch
                key={item.name}
                label={t(item.label)}
                description={
                  <>
                    {t(item.desc)}
                    {item.name === "ADMINISTRATOR" && <span className="mt-1 block font-medium text-warning">{t("perm.ADMINISTRATOR.warning")}</span>}
                    {editable && locked && <span className="mt-1 block">{t("roles.bitNotHeld")}</span>}
                  </>
                }
                checked={!!(permissions & bit)}
                disabled={locked}
                onChange={(on) => change(() => setPermissions(setBit(permissions, bit, on)))}
              />
            );
          })}
        </fieldset>
      ))}
      {unknownBits(permissions) !== 0 && <p className="text-small text-ink-muted">{t("roles.unknownBits", { bits: String(unknownBits(permissions)) })}</p>}
      <div aria-live="polite" className="empty:hidden">
        {save.isError && <Banner tone="danger">{errorMessage(save.error)}</Banner>}
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
