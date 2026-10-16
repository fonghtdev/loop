import { IMAGE_TYPES, type ImageKind } from "@loop/shared";
import { useId, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n/t";
import { imageFailureText, ImageUploadFailure } from "../lib/image-upload";
import { Button } from "./Button";

type Props = {
  kind: ImageKind;
  /** The current picture (or its placeholder) at its final size. */
  preview: ReactNode;
  hasImage: boolean;
  pickLabel: string;
  removeLabel: string;
  /** Uploads the chosen file; `onProgress` runs 0..1 during the PUT. Throws ImageUploadFailure (any other error reads as unknown). */
  onUpload: (file: File, onProgress: (fraction: number) => void) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
  /** Words for a failed removal (the server's own error is mapped by the caller). */
  removeError: (e: unknown) => string;
};

/**
 * Choose / replace / remove one image (avatar, banner, server icon). Type and size are checked before anything is sent;
 * while it works the buttons are off and the progress is told in a polite status line; a failure is a role=alert line.
 */
export function ImagePicker({ kind, preview, hasImage, pickLabel, removeLabel, onUpload, onRemove, removeError }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function choose(file: File | undefined) {
    if (!file) return;
    setError("");
    setBusy("upload");
    setPercent(0);
    try {
      await onUpload(file, (f) => setPercent(Math.round(f * 100)));
    } catch (e) {
      setError(imageFailureText(e instanceof ImageUploadFailure ? e.reason : "unknown", kind));
    } finally {
      setBusy(null);
      setPercent(null);
      if (input.current) input.current.value = ""; // choosing the same file again must fire change again
    }
  }

  async function remove() {
    setError("");
    setBusy("remove");
    try {
      await onRemove();
    } catch (e) {
      setError(removeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {preview}
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} id={id} type="file" accept={IMAGE_TYPES.join(",")} tabIndex={-1} aria-label={pickLabel} className="sr-only" onChange={(e) => void choose(e.target.files?.[0])} />
        <Button variant="secondary" loading={busy === "upload"} disabled={busy !== null} onClick={() => input.current?.click()}>
          {pickLabel}
        </Button>
        {hasImage && (
          <Button variant="ghost" loading={busy === "remove"} disabled={busy !== null} onClick={() => void remove()}>
            {removeLabel}
          </Button>
        )}
      </div>
      <p role="status" aria-live="polite" className="min-h-5 text-[13px] text-ink-muted empty:hidden">
        {percent !== null && t("image.uploading", { percent: String(percent) })}
      </p>
      <p role="alert" className="text-[13px] font-medium text-danger empty:hidden">
        {error}
      </p>
    </div>
  );
}
