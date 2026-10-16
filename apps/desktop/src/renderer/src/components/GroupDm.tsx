import { Crown, PencilSimple, SignOut, UserPlus, UsersThree, X } from "@phosphor-icons/react";
import { useId, useMemo, useState, type FormEvent } from "react";
import { MAX_GROUP_DM, MIN_GROUP_DM_INVITEES } from "@loop/shared";
import { t } from "../i18n/t";
import { session } from "../lib/app";
import { errorMessage } from "../lib/errors";
import { useNameOf } from "../lib/identity-hooks";
import { useBlocks, useFriends } from "../lib/queries";
import {
  addableFriends,
  canCreateGroup,
  filterFriends,
  groupRights,
  groupTitle,
  MAX_INVITEES,
  toggleInvitee,
  type Friend,
  type GroupDm,
} from "../lib/social";
import { addToGroup, createGroup, leaveGroup, removeFromGroup, renameGroup } from "../lib/social-actions";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { ConfirmBody } from "./Confirm";
import { Dialog, DialogActions, DialogError } from "./Dialog";
import { MenuItem, RowMenu } from "./RowMenu";
import { TextField } from "./TextField";
import { Tooltip } from "./Tooltip";

/** The title of a group as the signed-in user sees it (name, else "A, B, C"). */
export function useGroupTitle(g: GroupDm | undefined) {
  const me = session.useSession((s) => s.user?.id);
  const nameOf = useNameOf();
  return g ? groupTitle(g, me, nameOf, t("group.alone")) : "";
}

/** Two overlapping avatars of the other participants (one when only one is left). */
export function GroupAvatar({ g, size = "size-8" }: { g: GroupDm; size?: string }) {
  const me = session.useSession((s) => s.user?.id);
  const nameOf = useNameOf();
  const others = g.participants.filter((u) => u.id !== me).slice(0, 2);
  if (others.length < 2) return <Avatar id={others[0]?.id ?? g.id} name={others[0] ? nameOf(others[0].id, others[0].username) : "?"} className={`${size} shrink-0 rounded-full text-xs`} />;
  return (
    <span aria-hidden="true" className={`relative ${size} shrink-0`}>
      <Avatar id={others[0]!.id} name={nameOf(others[0]!.id, others[0]!.username)} className="absolute top-0 left-0 size-[70%] rounded-full text-[10px]" />
      <span className="absolute right-0 bottom-0 size-[70%] rounded-full ring-2 ring-surface-1">
        <Avatar id={others[1]!.id} name={nameOf(others[1]!.id, others[1]!.username)} className="size-full rounded-full text-[10px]" />
      </span>
    </span>
  );
}

/**
 * Search + chips + a checkbox list of friends: native checkboxes give the keyboard (Tab, Space) and the checked state
 * for screen readers; past `max` the unchecked boxes are disabled and the count says why.
 */
function FriendPicker({ friends, selected, onChange, max }: { friends: Friend[]; selected: string[]; onChange: (ids: string[]) => void; max: number }) {
  const nameOf = useNameOf();
  const [query, setQuery] = useState("");
  const listId = useId();
  const shown = useMemo(() => filterFriends(friends, query, nameOf), [friends, query, nameOf]);
  const full = selected.length >= max;
  const byId = new Map(friends.map((f) => [f.id, f]));
  return (
    <div className="flex flex-col gap-3">
      <TextField label={t("group.search")} type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} aria-controls={listId} />
      {selected.length > 0 && (
        <ul aria-label={t("group.selected")} className="flex flex-wrap gap-1.5">
          {selected.map((id) => {
            const f = byId.get(id);
            const name = f ? nameOf(f.id, f.username) : id;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onChange(toggleInvitee(selected, id, max))}
                  aria-label={t("group.unselect", { name  })}
                  className="flex h-8 max-w-48 items-center gap-1 rounded-full bg-moss-900 pr-1.5 pl-2.5 text-sm text-moss-200 hover:bg-surface-4"
                >
                  <span className="min-w-0 truncate">{name}</span>
                  <X aria-hidden="true" size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p role="status" aria-live="polite" className="text-caption text-ink-muted">
        {full ? t("group.full", { max: String(max) }) : t("group.count", { count: String(selected.length), max: String(max) })}
      </p>
      <ul id={listId} aria-label={t("group.friends")} className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
        {shown.map((f) => {
          const checked = selected.includes(f.id);
          const name = nameOf(f.id, f.username);
          return (
            <li key={f.id}>
              <label className={`flex h-11 items-center gap-2.5 rounded-control px-2 ${checked || !full ? "cursor-pointer hover:bg-white/5" : "cursor-not-allowed opacity-60"}`}>
                <input type="checkbox" checked={checked} disabled={!checked && full} onChange={() => onChange(toggleInvitee(selected, f.id, max))} className="size-4 shrink-0 accent-moss-400" />
                <Avatar id={f.id} name={name} className="size-8 shrink-0 rounded-full text-xs" />
                <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                {name !== f.username && <span className="max-w-32 shrink-0 truncate text-caption text-ink-faint">@{f.username}</span>}
              </label>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && <p className="text-sm text-ink-muted">{friends.length ? t("group.noMatch") : t("group.noFriends")}</p>}
    </div>
  );
}

/** Runs a dialog's submit: busy flag, the server's error in words, `onDone` on success. */
function useSubmit(action: () => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await action();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function CreateGroupForm({ onDone }: { onDone: () => void }) {
  const friends = useFriends().data?.friends;
  const blocks = useBlocks().data;
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const tooLong = [...name.trim()].length > 100;
  const pool = useMemo(() => (friends ?? []).filter((f) => !blocks?.some((b) => b.id === f.id)), [friends, blocks]);
  const s = useSubmit(() => createGroup(selected, name), onDone);
  return (
    <form onSubmit={(e) => void s.submit(e)} noValidate className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">{t("group.createBody", { min: String(MIN_GROUP_DM_INVITEES), max: String(MAX_INVITEES) })}</p>
      <FriendPicker friends={pool} selected={selected} onChange={setSelected} max={MAX_INVITEES} />
      <TextField label={t("group.name")} hint={t("group.nameHint")} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} error={tooLong ? t("group.nameTooLong") : undefined} />
      <DialogError message={s.error} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={s.busy} disabled={!canCreateGroup(selected) || tooLong}>
          {t("group.create")}
        </Button>
      </DialogActions>
    </form>
  );
}

/** The "new group" button of the DM column header, with its dialog. */
export function CreateGroupButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip label={t("group.createTitle")}>
        <button
          type="button"
          aria-label={t("group.createTitle")}
          onClick={() => setOpen(true)}
          className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-4 hover:text-ink"
        >
          <UsersThree aria-hidden="true" />
        </button>
      </Tooltip>
      <Dialog open={open} onClose={() => setOpen(false)} title={t("group.createTitle")}>
        <CreateGroupForm onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

function AddPeopleForm({ g, onDone }: { g: GroupDm; onDone: () => void }) {
  const friends = useFriends().data?.friends;
  const blocks = useBlocks().data;
  const pool = useMemo(() => addableFriends(friends ?? [], g, new Set(blocks?.map((b) => b.id))), [friends, blocks, g]);
  const room = MAX_GROUP_DM - g.participants.length;
  const [selected, setSelected] = useState<string[]>([]);
  // one call per person (the route adds one); stops at the first refusal, which is shown
  const s = useSubmit(async () => {
    for (const id of selected) await addToGroup(g.id, id);
  }, onDone);
  return (
    <form onSubmit={(e) => void s.submit(e)} noValidate className="flex flex-col gap-4">
      <FriendPicker friends={pool} selected={selected} onChange={setSelected} max={room} />
      <DialogError message={s.error} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={s.busy} disabled={!selected.length}>
          {t("group.add")}
        </Button>
      </DialogActions>
    </form>
  );
}

function RenameForm({ g, onDone }: { g: GroupDm; onDone: () => void }) {
  const [name, setName] = useState(g.name ?? "");
  const tooLong = [...name.trim()].length > 100;
  const s = useSubmit(() => renameGroup(g.id, name), onDone);
  return (
    <form onSubmit={(e) => void s.submit(e)} noValidate className="flex flex-col gap-4">
      <TextField label={t("group.name")} hint={t("group.renameHint")} autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} error={tooLong ? t("group.nameTooLong") : undefined} />
      <DialogError message={s.error} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={s.busy} disabled={tooLong}>
          {t("group.renameSubmit")}
        </Button>
      </DialogActions>
    </form>
  );
}

type Pending = { kind: "add" } | { kind: "rename" } | { kind: "leave" } | { kind: "remove"; user: Friend };

/** The members button of a group's header: who is in it (owner crowned) and what the viewer may do. */
export function GroupMembersMenu({ g }: { g: GroupDm }) {
  const me = session.useSession((s) => s.user?.id);
  const nameOf = useNameOf();
  const rights = groupRights(g, me);
  const [pending, setPending] = useState<Pending | null>(null);
  const close = () => setPending(null);
  const label = t("group.members", { count: String(g.participants.length) });
  return (
    <>
      <RowMenu id={`group-${g.id}`} label={label} trigger={<UsersThree aria-hidden="true" />} width="w-72">
        {(closeMenu) => {
          const then = (p: Pending) => () => {
            closeMenu();
            setPending(p);
          };
          return (
            <>
              <h2 className="px-2.5 pt-1 pb-1.5 text-micro font-semibold tracking-wide text-ink-muted uppercase">{label}</h2>
              <ul aria-label={label} className="flex max-h-72 flex-col overflow-y-auto">
                {g.participants.map((u) => {
                  const name = nameOf(u.id, u.username);
                  const owner = u.id === g.ownerId;
                  return (
                    <li key={u.id} className="flex h-11 items-center gap-2.5 px-2.5">
                      <Avatar id={u.id} name={name} className="size-7 shrink-0 rounded-full text-[11px]" />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {name}
                        {u.id === me && <span className="text-ink-faint"> {t("group.you")}</span>}
                      </span>
                      {owner && (
                        <Tooltip label={t("group.owner")}>
                          <span className="text-warning">
                            <Crown aria-hidden="true" weight="fill" size={16} />
                            <span className="sr-only">{t("group.owner")}</span>
                          </span>
                        </Tooltip>
                      )}
                      {rights.canRemove(u.id) && (
                        <Tooltip label={t("group.remove", { name  })}>
                          <button
                            type="button"
                            aria-label={t("group.remove", { name  })}
                            onClick={then({ kind: "remove", user: u })}
                            className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-danger"
                          >
                            <X aria-hidden="true" />
                          </button>
                        </Tooltip>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="mt-1 border-t border-hair pt-1">
                <MenuItem
                  icon={<UserPlus aria-hidden="true" />}
                  label={t("group.addPeople")}
                  description={rights.canAdd ? undefined : t("group.full", { max: String(MAX_GROUP_DM) })}
                  disabled={!rights.canAdd}
                  onClick={then({ kind: "add" })}
                />
                <MenuItem icon={<PencilSimple aria-hidden="true" />} label={t("group.rename")} onClick={then({ kind: "rename" })} />
                <MenuItem icon={<SignOut aria-hidden="true" />} label={t("group.leave")} danger onClick={then({ kind: "leave" })} />
              </div>
            </>
          );
        }}
      </RowMenu>
      <Dialog open={pending?.kind === "add"} onClose={close} title={t("group.addPeople")}>
        <AddPeopleForm g={g} onDone={close} />
      </Dialog>
      <Dialog open={pending?.kind === "rename"} onClose={close} title={t("group.rename")}>
        <RenameForm g={g} onDone={close} />
      </Dialog>
      <Dialog open={pending?.kind === "leave"} onClose={close} title={t("group.leaveTitle")}>
        <ConfirmBody body={t("group.leaveBody")} submit={t("group.leave")} onDone={close} action={() => leaveGroup(g.id)} />
      </Dialog>
      <Dialog open={pending?.kind === "remove"} onClose={close} title={t("group.removeTitle", { name: pending?.kind === "remove" ? nameOf(pending.user.id, pending.user.username) : ""  })}>
        {pending?.kind === "remove" && <ConfirmBody body={t("group.removeBody")} submit={t("group.removeSubmit")} onDone={close} action={() => removeFromGroup(g.id, pending.user.id).then(() => {})} />}
      </Dialog>
    </>
  );
}
