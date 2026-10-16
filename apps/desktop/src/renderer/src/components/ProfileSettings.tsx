import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { profileApi, session } from "../lib/app";
import { profiles } from "../lib/profiles";
import { errorMessage } from "../lib/errors";
import { bannerUrl } from "../lib/identity";
import { chars, draftErrors, draftOf, LIMITS, profilePatch, sameDraft, type ProfileDraft } from "../lib/profile-form";
import { profileKey, type UserProfile } from "../lib/profile-api";
import { useQuery } from "@tanstack/react-query";
import { toast } from "../lib/toast";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { ImagePicker } from "./ImagePicker";
import { TextField } from "./TextField";

/**
 * The "Hồ sơ" group of the user's settings: avatar and banner (each saved at once when its upload finishes), and the
 * text fields (display name, status, bio) saved together with Lưu / Huỷ thay đổi. Only changed fields are sent; the
 * form starts from the server's profile (a draft is not overwritten by a refetch while it is being edited).
 */
export function ProfileSettings() {
  const me = session.useSession((s) => s.user);
  const query = useQuery({ queryKey: profileKey(me?.id ?? ""), queryFn: () => profileApi.get(me!.id), enabled: !!me });
  const profile = query.data;
  const byId = useStore(profiles.store, (s) => s.byId);
  const live = me ? byId[me.id] : undefined;
  if (!me) return null;
  if (!profile) return <p role="status" className="px-3 py-3 text-[13px] text-ink-muted">{query.isError ? errorMessage(query.error) : t("profile.loading")}</p>;
  return (
    <div className="flex flex-col gap-5 px-3 py-2">
      <Pictures profile={profile} avatarHash={live?.avatarHash ?? profile.avatarHash} bannerHash={live?.bannerHash ?? profile.bannerHash} />
      <Fields key={profile.id} profile={profile} />
    </div>
  );
}

function Pictures({ profile, avatarHash, bannerHash }: { profile: UserProfile; avatarHash: string | null; bannerHash: string | null }) {
  const banner = bannerUrl(profile.id, bannerHash);
  const name = profile.displayName ?? profile.username;
  return (
    <div className="flex flex-col gap-4">
      <ImagePicker
        kind="banner"
        hasImage={!!banner}
        pickLabel={t("profile.banner.pick")}
        removeLabel={t("profile.banner.remove")}
        removeError={errorMessage}
        onUpload={(file, progress) => profileApi.setImage("banner", file, profile.id, progress)}
        onRemove={() => profileApi.removeImage("banner", profile.id)}
        preview={
          <div className="h-28 w-full max-w-md overflow-hidden rounded-card bg-surface-3 bg-[linear-gradient(135deg,var(--color-cosmic-900),var(--color-moss-900))]">
            {banner && <img key={banner} src={banner} alt="" loading="lazy" decoding="async" className="size-full object-cover" />}
          </div>
        }
      />
      <ImagePicker
        kind="avatar"
        hasImage={!!avatarHash}
        pickLabel={t("profile.avatar.pick")}
        removeLabel={t("profile.avatar.remove")}
        removeError={errorMessage}
        onUpload={(file, progress) => profileApi.setImage("avatar", file, profile.id, progress)}
        onRemove={() => profileApi.removeImage("avatar", profile.id)}
        preview={<Avatar id={profile.id} name={name} className="size-20 rounded-full text-2xl" />}
      />
    </div>
  );
}

function Fields({ profile }: { profile: UserProfile }) {
  const [draft, setDraft] = useState<ProfileDraft>(() => draftOf(profile));
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const bioId = useId();
  const synced = useRef(profile);
  const errors = draftErrors(draft);
  const patch = profilePatch(profile, draft);
  const changed = !sameDraft(draft, draftOf(profile));
  const set = (field: keyof ProfileDraft) => (value: string) => setDraft((d) => ({ ...d, [field]: value }));

  // the profile changed elsewhere (another device, user:updated): a form nobody has touched follows it
  useEffect(() => {
    setDraft((d) => (sameDraft(d, draftOf(synced.current)) ? draftOf(profile) : d));
    synced.current = profile;
  }, [profile]);

  async function save() {
    if (busy || !patch) return;
    setBusy(true);
    setServerError("");
    try {
      setDraft(draftOf(await profileApi.update(patch)));
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
      className="flex max-w-md flex-col gap-1"
    >
      <TextField label={t("profile.displayName")} hint={t("profile.displayNameHint", { username: profile.username })} placeholder={profile.username} value={draft.displayName} onChange={(e) => set("displayName")(e.target.value)} error={errors.displayName} />
      <TextField label={t("profile.statusText")} hint={t("profile.statusTextHint")} value={draft.statusText} onChange={(e) => set("statusText")(e.target.value)} error={errors.statusText} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={bioId} className="flex items-baseline justify-between text-sm font-medium text-ink">
          {t("profile.bio")}
          <span aria-hidden="true" className={`numeric text-caption font-normal ${chars(draft.bio) > LIMITS.bio ? "text-danger" : "text-ink-faint"}`}>
            {chars(draft.bio)}/{LIMITS.bio}
          </span>
        </label>
        <textarea
          id={bioId}
          rows={4}
          value={draft.bio}
          onChange={(e) => set("bio")(e.target.value)}
          aria-invalid={errors.bio ? true : undefined}
          aria-describedby={`${bioId}-error`}
          className={`w-full resize-y rounded-control border bg-surface-3 px-3.5 py-2.5 text-[15px] text-ink placeholder:text-ink-faint hover:bg-surface-4 ${errors.bio ? "border-danger" : "border-line-strong focus-visible:border-cosmic-300"}`}
        />
        <p id={`${bioId}-error`} aria-live="polite" className="mb-2 text-[13px] font-medium text-danger empty:hidden">
          {errors.bio}
        </p>
      </div>
      <p role="alert" className="text-[13px] font-medium text-danger empty:hidden">
        {serverError}
      </p>
      <div className="flex gap-2 pt-1">
        <Button type="submit" loading={busy} disabled={!patch}>
          {t("profile.save")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy || !changed}
          onClick={() => {
            setDraft(draftOf(profile));
            setServerError("");
          }}
        >
          {t("profile.discard")}
        </Button>
      </div>
    </form>
  );
}
