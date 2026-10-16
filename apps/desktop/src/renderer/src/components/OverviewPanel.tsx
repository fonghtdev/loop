import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useState } from "react";
import { t } from "../i18n/t";
import { guildNameError, type SettingsCtx } from "../lib/admin";
import { admin } from "../lib/app";
import { errorMessage } from "../lib/errors";
import { guildIconUrl } from "../lib/identity";
import { useGuild } from "../lib/queries";
import { toast } from "../lib/toast";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { ImagePicker } from "./ImagePicker";
import { TextField } from "./TextField";

/** "Tổng quan": the server's name and icon (ADMINISTRATOR or the owner; the tab is only offered to them). */
export function OverviewPanel({ ctx }: { ctx: SettingsCtx }) {
  const { guildId, guildName } = ctx;
  const iconHash = useGuild(guildId).data?.guild.iconHash;
  return (
    <div className="flex max-w-md flex-col gap-6">
      <ImagePicker
        kind="icon"
        hasImage={!!iconHash}
        pickLabel={t("overview.icon.pick")}
        removeLabel={t("overview.icon.remove")}
        removeError={errorMessage}
        onUpload={(file, progress) => admin.setGuildIcon(guildId, file, progress)}
        onRemove={() => admin.removeGuildIcon(guildId)}
        preview={<Avatar id={guildId} name={guildName} image={guildIconUrl(guildId, iconHash)} className="size-20 rounded-card text-2xl" />}
      />
      <NameForm key={guildName} guildId={guildId} current={guildName} />
    </div>
  );
}

function NameForm({ guildId, current }: { guildId: string; current: string }) {
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const error = guildNameError(name);
  const changed = name.trim() !== current;

  async function save() {
    if (busy || error || !changed) return;
    setBusy(true);
    setServerError("");
    try {
      await admin.renameGuild(guildId, name.trim());
      toast.push(t("userSettings.saved"));
    } catch (e) {
      setServerError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="flex flex-col gap-1"
    >
      <TextField label={t("overview.name")} maxLength={150} value={name} onChange={(e) => setName(e.target.value)} error={error} />
      <p role="alert" className="text-[13px] font-medium text-danger empty:hidden">
        {serverError}
      </p>
      <div className="flex gap-2 pt-1">
        <Button type="submit" loading={busy} disabled={!changed || !!error}>
          {t("profile.save")}
        </Button>
        <IconButton icon={<ArrowCounterClockwise />} label={t("profile.discard")} disabled={busy || !changed} onClick={() => (setName(current), setServerError(""))} />
      </div>
    </form>
  );
}
