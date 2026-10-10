import { INLINE_TYPES } from "@loop/shared";
import { createStore } from "zustand/vanilla";
import { step, type AttEvent, type AttState } from "./attachment-machine";
import { checkFiles, type Rejection } from "./attachment-rules";
import type { ConvKey } from "./conversation";
import { UploadFailure, type Uploader } from "./upload-client";

export type QueueItem = { id: string; file: File; filename: string; previewUrl: string | null; state: AttState };
/** An attachment that is ready to be sent (and the local preview the optimistic message shows meanwhile). */
export type ReadyAttachment = { id: string; filename: string; contentType: string; size: number; previewUrl: string | null };

type Deps = {
  convKey: ConvKey;
  upload: Uploader;
  newId?: () => string;
  /** Blob URL for an image's local preview; null for other files. */
  createPreview?: (file: File) => string | null;
  revokePreview?: (url: string) => void;
};

const defaultPreview = (file: File) => (INLINE_TYPES.includes(file.type) ? URL.createObjectURL(file) : null);

/**
 * The files of one composer: validates a batch with the shared limits, uploads each (state machine per file),
 * and hands the ready ones over when the message is sent. Outside React so it is testable; the composer subscribes.
 */
export function createAttachmentQueue({ convKey, upload, newId = () => crypto.randomUUID(), createPreview = defaultPreview, revokePreview = (u) => URL.revokeObjectURL(u) }: Deps) {
  const store = createStore<{ items: QueueItem[] }>(() => ({ items: [] }));
  const controllers = new Map<string, AbortController>();
  const items = () => store.getState().items;

  function apply(id: string, e: AttEvent) {
    store.setState((s) => {
      const item = s.items.find((i) => i.id === id);
      if (!item) return s; // removed meanwhile: late events change nothing
      const state = step(item.state, e);
      return state === item.state ? s : { items: s.items.map((i) => (i.id === id ? { ...i, state } : i)) };
    });
  }

  async function run(item: QueueItem) {
    const ctrl = new AbortController();
    controllers.set(item.id, ctrl);
    try {
      const done = await upload({ file: item.file, filename: item.filename, convKey, signal: ctrl.signal, emit: (e) => apply(item.id, e) });
      apply(item.id, { type: "done", id: done.id });
    } catch (e) {
      if (e instanceof UploadFailure && e.reason === "aborted") return;
      apply(item.id, { type: "fail", reason: e instanceof UploadFailure && e.reason !== "aborted" ? e.reason : "unknown" });
    } finally {
      controllers.delete(item.id);
    }
  }

  return {
    store,
    /** Files that pass start uploading at once; the others come back with the reason (nothing is uploaded for them). */
    add(files: File[]): { name: string; reason: Rejection }[] {
      const { accepted, rejected } = checkFiles(files, items().length);
      const added = accepted.map(({ file, filename }): QueueItem => ({ id: newId(), file, filename, previewUrl: createPreview(file), state: { phase: "picked" } }));
      store.setState((s) => ({ items: [...s.items, ...added] }));
      added.forEach((item) => void run(item));
      return rejected;
    },
    retry(id: string) {
      const item = items().find((i) => i.id === id);
      if (item?.state.phase !== "failed") return;
      apply(id, { type: "retry" });
      void run(item);
    },
    /** Abandons the upload (aborts the PUT; the server sweeps the orphan row and object). */
    remove(id: string) {
      const item = items().find((i) => i.id === id);
      if (!item) return;
      controllers.get(id)?.abort();
      if (item.previewUrl) revokePreview(item.previewUrl);
      store.setState((s) => ({ items: s.items.filter((i) => i.id !== id) }));
    },
    /** The message is being sent: the ready attachments leave the composer; their previews now belong to the pending message. */
    take(): ReadyAttachment[] {
      const taken = items().flatMap((i) => (i.state.phase === "ready" ? [{ id: i.state.id, filename: i.filename, contentType: i.file.type, size: i.file.size, previewUrl: i.previewUrl }] : []));
      store.setState({ items: [] });
      return taken;
    },
    /** The composer goes away (another conversation): stop everything, free the previews. */
    dispose() {
      controllers.forEach((c) => c.abort());
      items().forEach((i) => i.previewUrl && revokePreview(i.previewUrl));
      store.setState({ items: [] });
    },
  };
}
