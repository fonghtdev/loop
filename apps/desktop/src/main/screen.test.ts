import { describe, expect, it, vi } from "vitest";
import { createScreenShare } from "./screen";

const shot = (id: string) => ({ id, name: `name ${id}`, thumbnail: { toDataURL: () => `data:${id}` } });
const make = (platform = "win32", trusted = (u: string) => u.startsWith("app://loop")) => {
  const getSources = vi.fn(async () => [shot("screen:1"), shot("window:2")]);
  return { getSources, share: createScreenShare({ getSources, trusted, platform }) };
};
const ask = (share: ReturnType<typeof make>["share"], url = "app://loop/index.html") => {
  const callback = vi.fn();
  share.handler({ frame: { url } }, callback);
  return callback;
};

describe("createScreenShare", () => {
  it("lists screens and windows with data-URL thumbnails", async () => {
    const { share, getSources } = make();
    expect(await share.list()).toEqual([
      { id: "screen:1", name: "name screen:1", thumbnail: "data:screen:1" },
      { id: "window:2", name: "name window:2", thumbnail: "data:window:2" },
    ]);
    expect(getSources).toHaveBeenCalledWith(expect.objectContaining({ types: ["screen", "window"] }));
  });

  it("answers getDisplayMedia with the chosen source, once", async () => {
    const { share } = make();
    await share.list();
    share.choose("window:2", { audio: false });
    expect(ask(share)).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ id: "window:2" }) }));
    expect(ask(share)).toHaveBeenCalledWith({}); // a second request needs a new pick
  });

  it("refuses a request without a pick, and one from another page (consuming the pick)", async () => {
    const { share } = make();
    await share.list();
    expect(ask(share)).toHaveBeenCalledWith({});
    share.choose("screen:1", { audio: false });
    expect(ask(share, "https://evil.example/")).toHaveBeenCalledWith({});
    expect(ask(share)).toHaveBeenCalledWith({});
  });

  it("rejects an id that was not listed", async () => {
    const { share } = make();
    await share.list();
    for (const bad of ["screen:9", "", 1, null, undefined]) expect(() => share.choose(bad, { audio: false })).toThrow();
  });

  it("system audio only when asked for AND on Windows or macOS; otherwise the share is silent", async () => {
    for (const [platform, audio, expected] of [["win32", true, "loopback"], ["win32", false, undefined], ["darwin", true, "loopback"], ["darwin", false, undefined], ["linux", true, undefined]] as const) {
      const { share } = make(platform);
      await share.list();
      share.choose("screen:1", { audio });
      expect(ask(share).mock.calls[0][0].audio).toBe(expected);
    }
  });

  it("the audio request does not leak into the next pick", async () => {
    const { share } = make("win32");
    await share.list();
    share.choose("screen:1", { audio: true });
    ask(share);
    share.choose("screen:1", { audio: false });
    expect(ask(share).mock.calls[0][0].audio).toBeUndefined();
  });

  it("rejects options that are not exactly { audio: boolean }, and keeps no pick from them", async () => {
    const { share } = make("win32");
    await share.list();
    for (const bad of [undefined, null, true, "loopback", [], {}, { audio: "yes" }, { audio: 1 }, { audio: true, extra: 1 }, { video: true }]) expect(() => share.choose("screen:1", bad)).toThrow();
    expect(ask(share)).toHaveBeenCalledWith({});
  });
});
