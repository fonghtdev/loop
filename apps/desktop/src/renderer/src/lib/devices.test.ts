import { describe, expect, it, vi } from "vitest";
import { createDevices, effectiveChoice, labelsAvailable, optionsFor, parseChoices, type DeviceInfo, type DeviceKind } from "./devices";

const mic = (id: string, label = id): DeviceInfo => ({ kind: "audioinput", deviceId: id, label });
const cam = (id: string, label = id): DeviceInfo => ({ kind: "videoinput", deviceId: id, label });
const spk = (id: string, label = id): DeviceInfo => ({ kind: "audiooutput", deviceId: id, label });

describe("pure helpers", () => {
  it("parseChoices keeps only known kinds with non-empty string ids; junk is default", () => {
    expect(parseChoices('{"audioinput":"a","videoinput":"v","other":"x"}')).toEqual({ audioinput: "a", videoinput: "v" });
    expect(parseChoices('{"audioinput":5,"audiooutput":""}')).toEqual({});
    expect(parseChoices("not json")).toEqual({});
    expect(parseChoices(null)).toEqual({});
    expect(parseChoices(JSON.stringify({ audioinput: "x".repeat(513) }))).toEqual({});
  });

  it("optionsFor lists one kind, hides the virtual default entries, names unlabelled devices", () => {
    const list = [mic("default", "Default - X"), mic("communications"), mic("m1", "USB mic"), cam("c1", ""), spk("s1", "Speakers")];
    expect(optionsFor(list, "audioinput", "Micro")).toEqual([{ id: "m1", label: "USB mic" }]);
    expect(optionsFor(list, "videoinput", "Camera")).toEqual([{ id: "c1", label: "Camera 1" }]);
    expect(optionsFor([mic("")], "audioinput", "Micro")).toEqual([]); // ids hidden before access
  });

  it("labelsAvailable only once some device has a name", () => {
    expect(labelsAvailable([mic("", ""), cam("", "")])).toBe(false);
    expect(labelsAvailable([mic("m1", "USB mic")])).toBe(true);
  });

  it("effectiveChoice: the chosen device while present, the default once it is gone, kept while ids are hidden", () => {
    const list = [mic("m1"), mic("m2")];
    expect(effectiveChoice("m2", list, "audioinput")).toBe("m2");
    expect(effectiveChoice("m9", list, "audioinput")).toBeUndefined();
    expect(effectiveChoice(undefined, list, "audioinput")).toBeUndefined();
    expect(effectiveChoice("m9", [mic("")], "audioinput")).toBe("m9"); // cannot be checked yet
    expect(effectiveChoice("m9", [], "audioinput")).toBe("m9");
    expect(effectiveChoice("m1", [cam("m1")], "audioinput")).toBe("m1"); // a camera id is not a microphone
  });
});

function setup(stored: string | null = null, first: DeviceInfo[] = [mic("m1"), mic("m2"), spk("s1"), cam("c1")]) {
  let list = first;
  let saved = stored;
  const apply = vi.fn<(kind: DeviceKind, id: string | undefined) => void>();
  const d = createDevices({ storage: { read: () => saved, write: (v) => (saved = v) }, enumerate: async () => list, apply });
  return { d, apply, setList: (l: DeviceInfo[]) => (list = l), saved: () => saved };
}

describe("createDevices", () => {
  it("applies every kind once at the first refresh (the stored choice, or the default)", async () => {
    const s = setup('{"audioinput":"m2"}');
    await s.d.refresh();
    expect(s.apply.mock.calls).toEqual([["audioinput", "m2"], ["audiooutput", undefined], ["videoinput", undefined]]);
  });

  it("choosing applies at once and persists; choosing the default clears it", async () => {
    const s = setup();
    await s.d.refresh();
    s.apply.mockClear();
    s.d.choose("videoinput", "c1");
    expect(s.apply).toHaveBeenCalledExactlyOnceWith("videoinput", "c1");
    expect(JSON.parse(s.saved()!)).toEqual({ videoinput: "c1" });
    s.d.choose("videoinput", null);
    expect(s.apply).toHaveBeenLastCalledWith("videoinput", undefined);
    expect(JSON.parse(s.saved()!)).toEqual({});
  });

  it("a chosen device that disappears falls back to the default, and comes back when it reappears", async () => {
    const s = setup('{"audioinput":"m2","audiooutput":"s1"}');
    await s.d.refresh();
    s.apply.mockClear();
    s.setList([mic("m1"), spk("s1"), cam("c1")]); // m2 unplugged
    await s.d.refresh();
    expect(s.apply.mock.calls).toEqual([["audioinput", undefined]]);
    expect(s.d.effective("audioinput")).toBeUndefined();
    expect(s.d.store.getState().choices.audioinput).toBe("m2"); // the choice itself is remembered
    s.setList([mic("m1"), mic("m2"), spk("s1"), cam("c1")]);
    await s.d.refresh();
    expect(s.apply).toHaveBeenLastCalledWith("audioinput", "m2");
  });

  it("an unchanged list applies nothing; a failing enumeration empties the list without throwing", async () => {
    const s = setup();
    await s.d.refresh();
    s.apply.mockClear();
    await s.d.refresh();
    expect(s.apply).not.toHaveBeenCalled();
    const broken = createDevices({ storage: { read: () => null, write: () => undefined }, enumerate: async () => Promise.reject(new Error("no")), apply: vi.fn() });
    await expect(broken.refresh()).resolves.toBeUndefined();
    expect(broken.store.getState().devices).toEqual([]);
  });

  it("unreadable storage means defaults", async () => {
    const d = createDevices({
      storage: {
        read: () => {
          throw new Error("denied");
        },
        write: () => {
          throw new Error("denied");
        },
      },
      enumerate: async () => [],
      apply: vi.fn(),
    });
    expect(d.store.getState().choices).toEqual({});
    expect(() => d.choose("audioinput", "x")).not.toThrow();
  });
});
