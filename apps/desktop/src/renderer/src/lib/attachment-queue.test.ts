import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@loop/shared";
import { describe, expect, it, vi } from "vitest";
import { canSend } from "./attachment-machine";
import { createAttachmentQueue } from "./attachment-queue";
import { channelKey } from "./conversation";
import { UploadFailure, type UploadArgs } from "./upload-client";

/** The Send rule applied to what the composer holds. */
const sendable = (s: { queue: ReturnType<typeof createAttachmentQueue> }) =>
  canSend({ disabled: false, over: false, textLength: 0, files: s.queue.store.getState().items.map((i) => i.state) });
const png = (name = "a.png", size = 100) => new File([new Uint8Array(size)], name, { type: "image/png" });

/** An uploader the test drives by hand: each call waits for `finish` / `fail`. */
function setup() {
  const calls: (UploadArgs & { finish: (id?: string) => void; fail: (e: unknown) => void })[] = [];
  const upload = vi.fn(
    (args: UploadArgs) =>
      new Promise<never>((resolve, reject) => {
        calls.push({ ...args, finish: (id = `srv${calls.length}`) => resolve({ id, filename: args.filename, contentType: args.file.type, size: args.file.size, url: "u" } as never), fail: reject });
      }),
  );
  let n = 0;
  const revoked: string[] = [];
  const queue = createAttachmentQueue({ convKey: channelKey("c1"), upload, newId: () => `q${++n}`, createPreview: (f) => `blob:${f.name}`, revokePreview: (u) => revoked.push(u) });
  const isEmpty = () => queue.store.getState().items.length === 0;
  const phases = () => queue.store.getState().items.map((i) => i.state.phase);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { queue, calls, upload, phases, revoked, flush, isEmpty };
}

describe("attachment queue", () => {
  it("uploads accepted files at once; refused ones come back with the reason and nothing is uploaded for them", () => {
    const s = setup();
    const rejected = s.queue.add([png("ok.png"), png("big.png", MAX_ATTACHMENT_BYTES + 1), new File(["x"], "run.exe", { type: "application/x-msdownload" }), png("empty.png", 0)]);
    expect(rejected.map((r) => [r.name, r.reason])).toEqual([
      ["big.png", "tooLarge"],
      ["run.exe", "type"],
      ["empty.png", "empty"],
    ]);
    expect(s.upload).toHaveBeenCalledTimes(1);
    expect(s.queue.store.getState().items).toHaveLength(1);
  });

  it("Send stays unavailable while a file is in flight and opens when it is ready", async () => {
    const s = setup();
    s.queue.add([png()]);
    s.calls[0].emit({ type: "validate" });
    expect(sendable(s)).toBe(false);
    s.calls[0].emit({ type: "valid" });
    s.calls[0].emit({ type: "progress", value: 0.5 });
    expect(sendable(s)).toBe(false);
    expect(s.queue.store.getState().items[0].state).toEqual({ phase: "uploading", progress: 0.5 });
    s.calls[0].emit({ type: "uploaded" });
    s.calls[0].finish("srv-1");
    await s.flush();
    expect(sendable(s)).toBe(true);
    expect(s.queue.take()).toEqual([{ id: "srv-1", filename: "a.png", contentType: "image/png", size: 100, previewUrl: "blob:a.png" }]);
    expect(s.isEmpty()).toBe(true);
    expect(s.revoked).toEqual([]); // the previews now belong to the pending message
  });

  it("a failed upload keeps the file with its reason; retry runs it again and can succeed", async () => {
    const s = setup();
    s.queue.add([png()]);
    s.calls[0].emit({ type: "validate" });
    s.calls[0].fail(new UploadFailure("network"));
    await s.flush();
    expect(s.queue.store.getState().items[0].state).toEqual({ phase: "failed", reason: "network" });
    expect(sendable(s)).toBe(false);

    s.queue.retry("q1");
    expect(s.upload).toHaveBeenCalledTimes(2);
    s.calls[1].emit({ type: "validate" });
    s.calls[1].emit({ type: "valid" });
    s.calls[1].emit({ type: "uploaded" });
    s.calls[1].finish("srv-ok");
    await s.flush();
    expect(s.phases()).toEqual(["ready"]);
  });

  it("an unexpected error becomes an 'unknown' failure", async () => {
    const s = setup();
    s.queue.add([png()]);
    s.calls[0].emit({ type: "validate" });
    s.calls[0].fail(new Error("boom"));
    await s.flush();
    expect(s.queue.store.getState().items[0].state).toEqual({ phase: "failed", reason: "unknown" });
  });

  it("retry does nothing unless the file failed", () => {
    const s = setup();
    s.queue.add([png()]);
    s.queue.retry("q1");
    expect(s.upload).toHaveBeenCalledTimes(1);
  });

  it("removing mid-upload aborts the request, frees the preview and ignores late results", async () => {
    const s = setup();
    s.queue.add([png()]);
    s.calls[0].emit({ type: "validate" });
    s.calls[0].emit({ type: "valid" });
    s.queue.remove("q1");
    expect(s.calls[0].signal.aborted).toBe(true);
    expect(s.revoked).toEqual(["blob:a.png"]);
    expect(s.isEmpty()).toBe(true);
    s.calls[0].emit({ type: "progress", value: 0.9 });
    s.calls[0].finish();
    await s.flush();
    expect(s.isEmpty()).toBe(true);
  });

  it("an aborted upload that rejects does not mark anything failed", async () => {
    const s = setup();
    s.queue.add([png(), png("b.png")]);
    s.queue.remove("q1");
    s.calls[0].fail(new UploadFailure("aborted"));
    await s.flush();
    expect(s.phases()).toEqual(["picked"]);
  });

  it("holds at most 10 files across several adds", () => {
    const s = setup();
    s.queue.add(Array.from({ length: 8 }, (_, i) => png(`f${i}.png`)));
    const rejected = s.queue.add(Array.from({ length: 4 }, (_, i) => png(`g${i}.png`)));
    expect(s.queue.store.getState().items).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(rejected.map((r) => r.reason)).toEqual(["tooMany", "tooMany"]);
  });

  it("dispose aborts everything and frees the previews", () => {
    const s = setup();
    s.queue.add([png("a.png"), png("b.png")]);
    s.queue.dispose();
    expect(s.calls.every((c) => c.signal.aborted)).toBe(true);
    expect(s.revoked.sort()).toEqual(["blob:a.png", "blob:b.png"]);
    expect(s.isEmpty()).toBe(true);
  });
});
