import { Check } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/errors";
import { categoryNameError } from "../lib/validation";
import type { Category } from "../lib/categories";
import { Button } from "./Button";
import { DialogActions, DialogError } from "./Dialog";
import { MenuItem } from "./RowMenu";
import { TextField } from "./TextField";

/** The name of a category, to create or to change; the server's 409 (name taken) shows in Vietnamese. */
export function CategoryNameForm({ initial = "", submit, action, onDone }: { initial?: string; submit: string; action: (name: string) => Promise<unknown>; onDone: () => void }) {
  const [name, setName] = useState(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (busy || categoryNameError(name)) return;
    setBusy(true);
    setServerError("");
    try {
      await action(name.trim());
      onDone();
    } catch (err) {
      setServerError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <TextField label={t("category.name")} autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} error={tried ? categoryNameError(name) : undefined} />
      <DialogError message={serverError} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={busy}>
          {submit}
        </Button>
      </DialogActions>
    </form>
  );
}

/** Where a channel can go: every category, or none. The current place is marked. */
export function MoveChannelBody({ categories, current, onPick }: { categories: Category[]; current: string | null; onPick: (categoryId: string | null) => void }) {
  const places = [{ id: null, name: t("channels.noCategory") }, ...categories.map((c) => ({ id: c.id, name: c.name }))];
  return (
    <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto" aria-label={t("channels.move")}>
      {places.map((p) => (
        <li key={p.id ?? "none"}>
          <MenuItem icon={<Check aria-hidden="true" className={p.id === current ? "" : "invisible"} />} label={p.name} selected={p.id === current} onClick={() => onPick(p.id)} />
        </li>
      ))}
    </ul>
  );
}
