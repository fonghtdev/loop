import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "../i18n/t";
import { nameMatches, type SettingsCtx } from "../lib/admin";
import { admin } from "../lib/app";
import { errorMessage } from "../lib/errors";
import { Button } from "./Button";
import { ConfirmBody } from "./Confirm";
import { Dialog, DialogActions, DialogError } from "./Dialog";
import { Select } from "./OverwritesPanel";
import { TextField } from "./TextField";

/** Owner only: hand the server to someone else, or delete it (the name must be typed). */
export function DangerPanel({ ctx }: { ctx: SettingsCtx }) {
  const others = ctx.members.filter((m) => m.userId !== ctx.standing.userId);
  const [pick, setPick] = useState("");
  const [dialog, setDialog] = useState<"transfer" | "delete" | null>(null);
  const target = others.find((m) => m.userId === pick);
  const close = () => setDialog(null);
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <section aria-labelledby="transfer-title" className="flex flex-col gap-3 rounded-panel border border-line p-4">
        <h2 id="transfer-title" className="font-display text-base font-bold">
          {t("danger.transfer")}
        </h2>
        <p className="text-sm text-ink-muted">{t("danger.transferBody")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Select label={t("danger.transferTo")} value={pick} onChange={setPick}>
            <option value="">{t("danger.transferPick")}</option>
            {others.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.username}
              </option>
            ))}
          </Select>
          <Button type="button" disabled={!target} onClick={() => setDialog("transfer")}>
            {t("danger.transfer")}
          </Button>
        </div>
      </section>
      <section aria-labelledby="delete-title" className="flex flex-col gap-3 rounded-panel border border-danger p-4">
        <h2 id="delete-title" className="font-display text-base font-bold text-danger">
          {t("danger.delete")}
        </h2>
        <p className="text-sm text-ink-muted">{t("danger.deleteBody")}</p>
        <div>
          <Button type="button" onClick={() => setDialog("delete")} variant="danger">
            {t("danger.delete")}
          </Button>
        </div>
      </section>
      <Dialog open={dialog === "transfer" && !!target} onClose={close} title={t("danger.transferTitle", { name: target?.username ?? "" })}>
        {target && <ConfirmBody body={t("danger.transferConfirm")} submit={t("danger.transfer")} onDone={close} action={() => admin.transfer(ctx.guildId, target.userId).then(() => undefined)} />}
      </Dialog>
      <Dialog open={dialog === "delete"} onClose={close} title={t("danger.deleteTitle", { name: ctx.guildName })}>
        <DeleteBody ctx={ctx} onDone={close} />
      </Dialog>
    </div>
  );
}

function DeleteBody({ ctx, onDone }: { ctx: SettingsCtx; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const del = useMutation({ mutationFn: () => admin.deleteGuild(ctx.guildId) });
  const ok = nameMatches(typed, ctx.guildName);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !del.isPending) del.mutate();
      }}
      className="flex flex-col gap-4"
    >
      <p className="text-sm leading-relaxed text-ink-muted">{t("danger.deleteConfirm", { name: ctx.guildName })}</p>
      <TextField label={t("danger.typeName")} autoFocus spellCheck={false} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
      <DialogError message={del.isError ? errorMessage(del.error) : ""} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={!ok} loading={del.isPending} variant="danger">
          {t("danger.delete")}
        </Button>
      </DialogActions>
    </form>
  );
}
