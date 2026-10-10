import { hasPermission, Permission } from "@loop/shared";
import { Crown, ShieldCheck, UserMinus } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "../i18n/t";
import { callerChannelBits, canHandOutRole, canManageMember, type SettingsCtx } from "../lib/admin";
import { admin } from "../lib/app";
import type { Member } from "../lib/permissions";
import { Avatar } from "./Avatar";
import { ConfirmBody } from "./Confirm";
import { Dialog, DialogActions, DialogError } from "./Dialog";
import { Button } from "./Button";
import { errorMessage } from "../lib/errors";
import { MenuItem, RowMenu } from "./RowMenu";

const CHIPS = 3;

/** Everyone sees the members; the row menu appears only where the caller may do something to that member. */
export function MembersPanel({ ctx }: { ctx: SettingsCtx }) {
  const [dialog, setDialog] = useState<{ kind: "roles" | "kick"; userId: string } | null>(null);
  const { standing, ownerId, roles } = ctx;
  const byPosition = [...roles].sort((a, b) => b.position - a.position);
  const target = ctx.members.find((m) => m.userId === dialog?.userId);
  const close = () => setDialog(null);
  const mayAssign = (m: Member) => hasPermission(standing.bits, Permission.MANAGE_ROLES) && canManageMember(standing, m, ownerId, roles, "roles");
  const mayKick = (m: Member) => hasPermission(standing.bits, Permission.KICK_MEMBERS) && canManageMember(standing, m, ownerId, roles, "kick");

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <p className="text-sm text-ink-muted">{t("settingsMembers.intro", { count: String(ctx.members.length) })}</p>
      <ul aria-label={t("settingsMembers.list")} className="flex flex-col gap-1">
        {ctx.members.map((m) => {
          const chips = byPosition.filter((r) => m.roleIds.includes(r.id));
          return (
            <li key={m.userId} className="flex min-h-14 items-center gap-3 rounded-control border border-line px-3 py-1.5">
              <Avatar id={m.userId} name={m.username} className="size-8 rounded-full text-xs" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-sm font-medium select-text" title={m.username}>
                    {m.username}
                  </span>
                  {m.userId === ownerId && (
                    <span title={t("members.owner")} className="shrink-0 text-warning">
                      <Crown aria-hidden="true" weight="fill" size={16} />
                      <span className="sr-only">{t("members.owner")}</span>
                    </span>
                  )}
                </div>
                {chips.length > 0 && (
                  <ul aria-label={t("settingsMembers.roles")} className="mt-1 flex flex-wrap gap-1">
                    {chips.slice(0, CHIPS).map((r) => (
                      <li key={r.id} title={r.name} className="max-w-28 truncate rounded-control bg-surface-3 px-2 py-0.5 text-xs text-ink-muted">
                        {r.name}
                      </li>
                    ))}
                    {chips.length > CHIPS && <li className="rounded-control bg-surface-3 px-2 py-0.5 text-xs text-ink-muted">+{chips.length - CHIPS}</li>}
                  </ul>
                )}
              </div>
              {(mayAssign(m) || mayKick(m)) && (
                <RowMenu id={`m-${m.userId}`} label={t("settingsMembers.menu", { name: m.username })}>
                  {(closeMenu) => (
                    <>
                      {mayAssign(m) && (
                        <MenuItem
                          icon={<ShieldCheck aria-hidden="true" />}
                          label={t("settingsMembers.assign")}
                          onClick={() => {
                            closeMenu();
                            setDialog({ kind: "roles", userId: m.userId });
                          }}
                        />
                      )}
                      {mayKick(m) && (
                        <MenuItem
                          icon={<UserMinus aria-hidden="true" />}
                          label={t("settingsMembers.kick")}
                          danger
                          onClick={() => {
                            closeMenu();
                            setDialog({ kind: "kick", userId: m.userId });
                          }}
                        />
                      )}
                    </>
                  )}
                </RowMenu>
              )}
            </li>
          );
        })}
      </ul>
      <Dialog open={dialog?.kind === "roles" && !!target} onClose={close} title={t("settingsMembers.assignTitle", { name: target?.username ?? "" })}>
        {target && <AssignBody ctx={ctx} member={target} onDone={close} />}
      </Dialog>
      <Dialog open={dialog?.kind === "kick" && !!target} onClose={close} title={t("settingsMembers.kickTitle", { name: target?.username ?? "" })}>
        {target && <ConfirmBody body={t("settingsMembers.kickBody")} submit={t("settingsMembers.kick")} onDone={close} action={() => admin.kick(ctx.guildId, target.userId)} />}
      </Dialog>
    </div>
  );
}

/** A checklist that applies each tick at once. Roles the caller cannot hand out and the member lacks stay hidden (rule 2b). */
function AssignBody({ ctx, member, onDone }: { ctx: SettingsCtx; member: Member; onDone: () => void }) {
  const { standing, guildId } = ctx;
  const channels = ctx.channels.map((c) => ({ overwrites: c.overwrites, bits: callerChannelBits(ctx, c) }));
  const roles = [...ctx.roles]
    .filter((r) => r.id !== guildId)
    .sort((a, b) => b.position - a.position)
    .filter((r) => member.roleIds.includes(r.id) || canHandOutRole(standing, r, channels));
  const toggle = useMutation({
    mutationFn: ({ roleId, on }: { roleId: string; on: boolean }) => (on ? admin.assignRole(guildId, member.userId, roleId) : admin.unassignRole(guildId, member.userId, roleId)),
  });
  return (
    <>
      {roles.length === 0 && <p className="text-sm text-ink-muted">{t("settingsMembers.noRoles")}</p>}
      <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        {roles.map((r) => {
          const locked = !canHandOutRole(standing, r, channels);
          return (
            <li key={r.id}>
              <label title={locked ? t("settingsMembers.roleLocked") : undefined} className={`flex min-h-10 items-center gap-3 rounded-control px-2 ${locked ? "opacity-70" : "cursor-pointer hover:bg-surface-4"}`}>
                <input
                  type="checkbox"
                  checked={member.roleIds.includes(r.id)}
                  disabled={locked || toggle.isPending}
                  onChange={(e) => toggle.mutate({ roleId: r.id, on: e.target.checked })}
                  className="size-5 shrink-0 accent-moss-400"
                />
                <span className="min-w-0 truncate" title={r.name}>
                  {r.name}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <DialogError message={toggle.isError ? errorMessage(toggle.error) : ""} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone} autoFocus>
          {t("common.close")}
        </Button>
      </DialogActions>
    </>
  );
}
