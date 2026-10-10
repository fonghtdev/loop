import type { AuthClient } from "./auth-client";
import { ApiError } from "./auth-client";
import type { AttEvent, Failure } from "./attachment-machine";
import type { ConvKey } from "./conversation";
import { uploadTarget } from "./conversation";

export class UploadFailure extends Error {
  constructor(readonly reason: Failure | "aborted") {
    super(reason);
  }
}

/** The part of XMLHttpRequest used here (tests pass a fake). */
export type XhrLike = {
  status: number;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
};

/**
 * PUT the bytes to storage straight from the renderer (no Authorization header: the URL is the credential).
 * ponytail: XMLHttpRequest, because fetch cannot report upload progress; swap for fetch streams when it can.
 */
export function putFile(
  url: string,
  headers: Record<string, string>,
  file: Blob,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
  createXhr: () => XhrLike = () => new XMLHttpRequest() as unknown as XhrLike,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new UploadFailure("aborted"));
    const xhr = createXhr();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => e.lengthComputable && e.total > 0 && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new UploadFailure("storage")));
    xhr.onerror = () => reject(new UploadFailure("network"));
    xhr.onabort = () => reject(new UploadFailure("aborted"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** What a failed API call during upload means for the user. */
export function failureOf(err: unknown, stage: "create" | "complete"): Failure {
  if (!(err instanceof ApiError)) return "unknown";
  if (err.status === 0) return "network";
  if (err.status === 400) return stage === "create" ? "rejected" : "mismatch";
  if (err.status === 429) return "tooMany";
  if (err.status === 403 || err.status === 404) return "denied";
  return "unknown";
}

export type ServerAttachment = { id: string; filename: string; contentType: string; size: number; url: string };
export type UploadArgs = {
  file: File;
  filename: string;
  convKey: ConvKey;
  signal: AbortSignal;
  /** Machine events for the progress of this upload. */
  emit: (e: AttEvent) => void;
};
export type Uploader = (args: UploadArgs) => Promise<ServerAttachment>;

type Deps = { request: AuthClient["request"]; createXhr?: () => XhrLike };

/** The three-step flow of the server contract: reserve, PUT to storage, complete (the server verifies the bytes). */
export function createUploader({ request, createXhr }: Deps): Uploader {
  return async ({ file, filename, convKey, signal, emit }) => {
    emit({ type: "validate" });
    let reserved: { id: string; uploadUrl: string; headers: Record<string, string> };
    try {
      reserved = await request("POST", "/attachments", { filename, contentType: file.type, size: file.size, ...uploadTarget(convKey) });
    } catch (e) {
      throw new UploadFailure(failureOf(e, "create"));
    }
    if (signal.aborted) throw new UploadFailure("aborted");
    emit({ type: "valid" });
    await putFile(reserved.uploadUrl, reserved.headers, file, (value) => emit({ type: "progress", value }), signal, createXhr);
    emit({ type: "uploaded" });
    try {
      return await request<ServerAttachment>("POST", `/attachments/${reserved.id}/complete`);
    } catch (e) {
      throw new UploadFailure(failureOf(e, "complete"));
    }
  };
}
