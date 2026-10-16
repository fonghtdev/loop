import { IMAGE_MAX_BYTES, IMAGE_TYPES, type ImageKind } from "@loop/shared";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";
import { ApiError, type AuthClient } from "./auth-client";
import { putFile, UploadFailure, type XhrLike } from "./upload-client";

export type ImageFailure = "type" | "size" | "expired" | "rejected" | "mismatch" | "storage" | "network" | "tooMany" | "denied" | "unknown" | "aborted";

/** The upload could not finish; `reason` says why (the words are `imageFailureText`). */
export class ImageUploadFailure extends Error {
  constructor(readonly reason: ImageFailure) {
    super(reason);
  }
}

/** Checked before any request, with the same limits as the server (a refusal there costs a round trip for nothing). */
export function checkImage(file: { type: string; size: number }, kind: ImageKind): "type" | "size" | null {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return "type";
  return file.size < 1 || file.size > IMAGE_MAX_BYTES[kind] ? "size" : null;
}

const TEXT: Record<ImageFailure, MessageKey> = {
  type: "image.failed.type",
  size: "image.failed.size",
  expired: "image.failed.expired",
  rejected: "image.failed.rejected",
  mismatch: "image.failed.mismatch",
  storage: "image.failed.storage",
  network: "image.failed.network",
  tooMany: "image.failed.tooMany",
  denied: "image.failed.denied",
  unknown: "image.failed.unknown",
  aborted: "image.failed.unknown",
};

/** What to tell the user; `kind` only matters for the size limit in the words. */
export function imageFailureText(reason: ImageFailure, kind: ImageKind): string {
  return t(TEXT[reason], { max: String(IMAGE_MAX_BYTES[kind] / (1024 * 1024)) });
}

function failureOf(err: unknown, stage: "reserve" | "complete"): ImageFailure {
  if (!(err instanceof ApiError)) return "unknown";
  if (err.status === 0) return "network";
  if (err.status === 400) return stage === "complete" && /expired/i.test(err.serverMessage ?? "") ? "expired" : stage === "reserve" ? "rejected" : "mismatch";
  if (err.status === 429) return "tooMany";
  if (err.status === 403 || err.status === 404) return "denied";
  return "unknown";
}

export type ImageUploader = (args: { base: string; kind: ImageKind; file: File; onProgress?: (fraction: number) => void; signal?: AbortSignal }) => Promise<string>;

/**
 * The three steps of the server contract for avatar, banner and server icon (`base` = `/me/avatar`, `/me/banner`,
 * `/guilds/:id/icon`): reserve -> PUT to storage (no Authorization: the URL is the credential) -> complete. Resolves to
 * the new image hash; throws ImageUploadFailure. Type and size are refused before any request.
 */
export function createImageUploader({ request, createXhr }: { request: AuthClient["request"]; createXhr?: () => XhrLike }): ImageUploader {
  return async ({ base, kind, file, onProgress = () => undefined, signal = new AbortController().signal }) => {
    const refused = checkImage(file, kind);
    if (refused) throw new ImageUploadFailure(refused);
    let reserved: { id: string; uploadUrl: string; headers: Record<string, string> };
    try {
      reserved = await request("POST", `${base}/upload`, { contentType: file.type, size: file.size });
    } catch (e) {
      throw new ImageUploadFailure(failureOf(e, "reserve"));
    }
    try {
      await putFile(reserved.uploadUrl, reserved.headers, file, onProgress, signal, createXhr);
    } catch (e) {
      throw new ImageUploadFailure(e instanceof UploadFailure ? (e.reason === "network" || e.reason === "aborted" ? e.reason : "storage") : "unknown");
    }
    try {
      return (await request<{ hash: string }>("POST", `${base}/complete`, { id: reserved.id })).hash;
    } catch (e) {
      throw new ImageUploadFailure(failureOf(e, "complete"));
    }
  };
}
