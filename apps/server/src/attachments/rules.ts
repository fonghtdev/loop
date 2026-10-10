import { type AttachmentType, INLINE_TYPES } from "@loop/shared";

export const MAX_PENDING_PER_USER = 20;
export const SNIFF_BYTES = 4096;
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Uploads land under `uploads/` (the presigned PUT stays valid for 5 minutes, so that key can be rewritten
 * even after verification). `complete` copies the verified version to `files/`, the only key ever served.
 */
export const uploadKey = (id: string) => `uploads/${id}`;
export const finalKey = (id: string) => `files/${id}`;

const ascii = (b: Uint8Array, at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/** What the first bytes must look like for each allowed type. */
const SIGNATURES: Record<AttachmentType, (b: Uint8Array) => boolean> = {
  "image/png": (b) => b[0] === 0x89 && ascii(b, 1, "PNG"),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"),
  "image/webp": (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP"),
  "application/pdf": (b) => ascii(b, 0, "%PDF-"),
  "application/zip": (b) => ascii(b, 0, "PK") && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6)),
  "video/mp4": (b) => ascii(b, 4, "ftyp"),
  "audio/mpeg": (b) => ascii(b, 0, "ID3") || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0),
  "text/plain": (b) => !b.includes(0),
};

/** Do the real bytes agree with the declared type? (Never trust the client's word for it.) */
export const matchesType = (contentType: string, bytes: Uint8Array) =>
  bytes.length > 0 && SIGNATURES[contentType as AttachmentType]?.(bytes) === true;

/** Images show inline; everything else downloads, under the stored (sanitized) name. */
export function contentDisposition(contentType: string, filename: string) {
  if (INLINE_TYPES.includes(contentType)) return "inline";
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}
