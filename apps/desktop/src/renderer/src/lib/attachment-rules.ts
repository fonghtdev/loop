import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, sanitizeFilename } from "@loop/shared";

export type FileLike = { name: string; size: number; type: string };
export type Rejection = "empty" | "tooLarge" | "type" | "tooMany" | "name";

/**
 * Client-side check with the SAME constants as the server (it stays the authority). `held` = files already in
 * the composer. The File's real `type` is used; unknown or empty is refused.
 */
export function checkFile(file: FileLike, held: number): { ok: true; filename: string } | { ok: false; reason: Rejection } {
  if (held >= MAX_ATTACHMENTS_PER_MESSAGE) return { ok: false, reason: "tooMany" };
  if (file.size <= 0) return { ok: false, reason: "empty" };
  if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "tooLarge" };
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return { ok: false, reason: "type" };
  const filename = sanitizeFilename(file.name);
  return filename ? { ok: true, filename } : { ok: false, reason: "name" };
}

/** A batch against what is already held: files that pass (with their clean names) and the ones refused. */
export function checkFiles<T extends FileLike>(files: T[], held: number) {
  const accepted: { file: T; filename: string }[] = [];
  const rejected: { name: string; reason: Rejection }[] = [];
  for (const file of files) {
    const r = checkFile(file, held + accepted.length);
    if (r.ok) accepted.push({ file, filename: r.filename });
    else rejected.push({ name: file.name, reason: r.reason });
  }
  return { accepted, rejected };
}

/** "1,5 MB" (Vietnamese decimal comma). */
export function formatSize(bytes: number): string {
  const unit = bytes < 1024 ? ["B", 1] : bytes < 1024 ** 2 ? ["KB", 1024] : ["MB", 1024 ** 2];
  const value = bytes / (unit[1] as number);
  return `${unit[0] === "B" ? value : value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })} ${unit[0]}`;
}

export type FileKind = "image" | "pdf" | "zip" | "text" | "video" | "audio";
export function fileKind(contentType: string): FileKind {
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf") return "pdf";
  if (contentType === "application/zip") return "zip";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "text";
}
