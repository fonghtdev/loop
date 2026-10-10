import type { ObjectStorage } from "../storage.js";
import { contentDisposition } from "./rules.js";

export const attachmentSelect = { id: true, filename: true, contentType: true, size: true, objectKey: true } as const;

type Row = { id: string; filename: string; contentType: string; size: number; objectKey: string };

/** Public shape: the object key stays server-side; `url` is a presigned GET (1 hour) with the validated type forced. */
export async function attachmentDto(a: Row, storage: ObjectStorage) {
  const { id, filename, contentType, size } = a;
  return { id, filename, contentType, size, url: await storage.presignGet(a.objectKey, contentType, contentDisposition(contentType, filename)) };
}
