import { useId, useState, type FormEvent } from "react";
import { t } from "../i18n/t";
import { channelEditError, channelPatch } from "../lib/admin";
import { admin } from "../lib/app";
import { errorMessage } from "../lib/errors";
import type { Channel } from "../lib/permissions";
import { normalizeChannelName } from "../lib/validation";
import { Button } from "./Button";
import { DialogActions, DialogError } from "./Dialog";
import { TextField } from "./TextField";

/** Rename a channel and set its topic (MANAGE_CHANNELS). Only what changed is sent; a taken name comes back as the server's 409. */
export function EditChannelForm({ guildId, channel, onDone }: { guildId: string; channel: Channel; onDone: () => void }) {
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const topicId = useId();
  const errors = channelEditError({ name, topic });
  const patch = channelPatch(channel, { name, topic });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || errors.name || errors.topic || !patch) return;
    setBusy(true);
    setServerError("");
    try {
      await admin.updateChannel(guildId, channel.id, patch);
      onDone();
    } catch (err) {
      setServerError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <TextField label={t("createChannel.name")} hint={t("createChannel.nameHint")} autoFocus spellCheck={false} maxLength={100} value={name} onChange={(e) => setName(normalizeChannelName(e.target.value))} error={errors.name} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={topicId} className="text-sm font-medium text-ink">
          {t("channels.topic")}
        </label>
        <textarea
          id={topicId}
          rows={3}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          aria-invalid={errors.topic ? true : undefined}
          aria-describedby={`${topicId}-error`}
          className={`w-full resize-y rounded-control border bg-surface-3 px-3.5 py-2.5 text-[15px] text-ink placeholder:text-ink-faint hover:bg-surface-4 ${errors.topic ? "border-danger" : "border-line-strong focus-visible:border-cosmic-300"}`}
        />
        <p id={`${topicId}-error`} aria-live="polite" className="text-[13px] font-medium text-danger empty:hidden">
          {errors.topic}
        </p>
      </div>
      <DialogError message={serverError} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={busy} disabled={!patch || !!errors.name || !!errors.topic}>
          {t("profile.save")}
        </Button>
      </DialogActions>
    </form>
  );
}
