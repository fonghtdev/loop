import { describe, expect, it, vi } from "vitest";
import type { GoLivePrefs, ShareChoice } from "./golive";
import { createScreenPicker } from "./screen-picker";

const sources = [{ id: "screen:1", name: "Screen 1", thumbnail: "data:x" }];
const devices = [{ id: "cam1", label: "Capture card" }];
const choice: ShareChoice = { source: { kind: "display", id: "screen:1" }, quality: { resolution: "720", fps: 60 }, audio: true, label: "Screen 1" };
const prefs: GoLivePrefs = { resolution: "720", fps: 60, audio: true };
const make = () => {
  const save = vi.fn();
  return { save, picker: createScreenPicker({ list: async () => sources, devices: async () => devices, save }) };
};
const opened = async (picker: ReturnType<typeof make>["picker"]) => {
  const result = picker.pick();
  await vi.waitFor(() => expect(picker.store.getState().open).toEqual({ sources, devices }));
  return result;
};

describe("createScreenPicker", () => {
  it("opens with the sources and the cameras; confirming closes, resolves the choice and remembers the prefs", async () => {
    const { picker, save } = make();
    const result = opened(picker);
    await vi.waitFor(() => expect(picker.store.getState().open).not.toBeNull());
    picker.confirm(choice, prefs);
    expect(await result).toEqual(choice);
    expect(save).toHaveBeenCalledWith(prefs);
    expect(picker.store.getState().open).toBeNull();
  });

  it("cancel resolves null, closes and remembers nothing", async () => {
    const { picker, save } = make();
    const result = opened(picker);
    await vi.waitFor(() => expect(picker.store.getState().open).not.toBeNull());
    picker.cancel();
    expect(await result).toBeNull();
    expect(picker.store.getState().open).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("a new pick cancels the one still open", async () => {
    const { picker } = make();
    const first = picker.pick();
    await vi.waitFor(() => expect(picker.store.getState().open).not.toBeNull());
    void picker.pick();
    expect(await first).toBeNull();
  });
});
