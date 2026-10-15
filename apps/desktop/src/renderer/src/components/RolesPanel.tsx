import { Permission } from "@loop/shared";
import { CaretLeft, Lock, Plus } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "../i18n/t";
import { canManageRole, grantableBits, patchRole, PERMISSION_GROUPS, roleNameError, setBit, unknownBits, type SettingsCtx } from "../lib/admin";
import { admin } from "../lib/app";
import { errorMessage } from "../lib/errors";
import type { Role } from "../lib/permissions";
import { isRoleColor, ROLE_COLORS } from "../lib/role-colors";
import { toast } from "../lib/toast";
import { roleColor } from "../lib/user-card";
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
              {r.id !== guildId && <span aria-hidden="true" className="size-3 shrink-0 rounded-full" style={{ backgroundColor: roleColor(r) }} />}
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
  const [color, setColor] = useState<string | null>(role?.color ?? null);
  const [hex, setHex] = useState(role?.color ?? "");
  const [tried, setTried] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const held = grantableBits(standing.bits);
  const patch = role ? patchRole(role, { name, permissions, color }) : null;
  const nameError = isEveryone ? undefined : roleNameError(name);
  const hexInvalid = hex !== "" && !isRoleColor(hex);

  const save = useMutation({
    mutationFn: async () => {
      if (!role) await admin.createRole(guildId, { name: name.trim(), permissions, color });
      else if (patch) await admin.updateRole(guildId, role.id, patch);
    },
    onSuccess: () => (role ? toast.push(t("roles.saved")) : onBack()),
  });
  const change = (fn: () => void) => {
    save.reset();
    toast.dismiss(); // "saved" is no longer true of what is on screen
    fn();
  };
  const pickColor = (c: string | null) =>
    change(() => {
      setColor(c);
      setHex(c ?? "");
    });
  const typeHex = (v: string) =>
    change(() => {
      setHex(v);
      if (isRoleColor(v)) setColor(v);
      else if (v === "") setColor(null);
    });
  const submit = () => {
    setTried(true);
    if (!nameError && !hexInvalid && !save.isPending) save.mutate();
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
      {!isEveryone && (
        <ColorPicker
          color={color}
          hex={hex}
          error={hexInvalid && (tried || hex.length >= 7) ? t("roles.color.invalid") : undefined}
          disabled={!editable}
          onPick={pickColor}
          onType={typeHex}
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

/** 16 swatches, "no color", and a custom #RRGGBB field. `hex` is the raw text of the field (may be mid-typing and invalid). */
function ColorPicker({ color, hex, error, disabled, onPick, onType }: { color: string | null; hex: string; error: string | undefined; disabled: boolean; onPick: (c: string | null) => void; onType: (v: string) => void }) {
  const swatch = (selected: boolean) =>
    `grid size-8 place-items-center rounded-full outline-offset-2 transition-transform duration-(--duration-fast) enabled:hover:scale-110 enabled:active:scale-95 ${selected ? "ring-2 ring-ink ring-offset-2 ring-offset-raise" : ""}`;
  return (
    <fieldset className="relative edge flex min-w-0 flex-col gap-3 rounded-panel bg-raise p-4 shadow-e2">
      <legend className="sr-only">{t("roles.color")}</legend>
      <p aria-hidden="true" className="font-display text-small font-bold tracking-wide text-ink-muted uppercase">
        {t("roles.color")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={disabled} aria-pressed={color === null} onClick={() => onPick(null)} className={`h-8 rounded-full border border-line-strong px-3 text-small font-medium text-ink-muted ${color === null ? "ring-2 ring-ink ring-offset-2 ring-offset-raise" : "enabled:hover:bg-white/[.045]"}`}>
          {t("roles.color.none")}
        </button>
        {ROLE_COLORS.map((c) => (
          <button key={c} type="button" disabled={disabled} aria-pressed={color?.toLowerCase() === c} aria-label={t("roles.color.swatch", { color: c })} onClick={() => onPick(c)} className={swatch(color?.toLowerCase() === c)} style={{ backgroundColor: c }} />
        ))}
      </div>
      <TextField label={t("roles.color.custom")} maxLength={7} placeholder="#RRGGBB" value={hex} disabled={disabled} onChange={(e) => onType(e.target.value.trim())} error={error} />
    </fieldset>
  );
}
