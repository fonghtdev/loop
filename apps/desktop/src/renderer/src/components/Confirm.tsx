import { useState } from "react";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/errors";
import { Button } from "./Button";
import { DialogActions, DialogError } from "./Dialog";

/** The body of a confirm dialog: explains, runs `action` on the destructive button, shows the failure inline. */
export function ConfirmBody({ body, submit, onDone, action }: { body: string; submit: string; onDone: () => void; action: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run() {
    setBusy(true);
    setError("");
    try {
      await action();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <>
      <p className="text-sm leading-relaxed text-ink-muted">{body}</p>
      <DialogError message={error} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone} autoFocus>
          {t("common.cancel")}
        </Button>
        <Button type="button" loading={busy} onClick={() => void run()} variant="danger">
          {submit}
        </Button>
      </DialogActions>
    </>
  );
}
