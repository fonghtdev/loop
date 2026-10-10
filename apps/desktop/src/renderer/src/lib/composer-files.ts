import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { rejectionText } from "./attachment-text";
import { createAttachmentQueue } from "./attachment-queue";
import { uploadAttachment } from "./app";
import type { ConvKey } from "./conversation";

/** The attachments of the composer of one conversation: the queue, its items, and the notices about refused files. */
export function useComposerFiles(convKey: ConvKey) {
  const queue = useMemo(() => createAttachmentQueue({ convKey, upload: uploadAttachment }), [convKey]);
  const items = useStore(queue.store, (s) => s.items);
  const [notices, setNotices] = useState<string[]>([]);
  useEffect(() => () => queue.dispose(), [queue]); // another conversation: abort what is still uploading

  return {
    queue,
    items,
    notices,
    add(files: File[]) {
      if (files.length) setNotices(queue.add(files).map((r) => rejectionText(r.name, r.reason)));
    },
    clearNotices: () => setNotices([]),
  };
}
export type ComposerFiles = ReturnType<typeof useComposerFiles>;
