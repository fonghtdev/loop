import { describe, expect, it } from "vitest";
import type { ShareChoice } from "./golive";
import { streamMenu, type StreamMenuRow } from "./stream-menu";

const screen: ShareChoice = { source: { kind: "display", id: "screen:1" }, quality: { resolution: "1080", fps: 30 }, audio: true, label: "Màn hình 1" };
const camera: ShareChoice = { source: { kind: "device", deviceId: "cap" }, quality: { resolution: "720", fps: 60 }, audio: false, label: "Capture" };
const row = <I extends StreamMenuRow["id"]>(rows: StreamMenuRow[], id: I) => rows.find((r) => r.id === id) as Extract<StreamMenuRow, { id: I }>;
const checked = (r: { options: { value: unknown; checked: boolean }[] }) => r.options.filter((o) => o.checked).map((o) => o.value);

describe("streamMenu", () => {
  it("has stop, change, resolution, frame rate and sound, in that order (no report row)", () => {
    expect(streamMenu(screen, "win32").map((r) => r.id)).toEqual(["stop", "change", "resolution", "fps", "audio"]);
  });

  it("marks exactly the current resolution and frame rate", () => {
    const rows = streamMenu(screen, "win32");
    expect(row(rows, "resolution").options.map((o) => o.value)).toEqual(["720", "1080", "native"]);
    expect(checked(row(rows, "resolution"))).toEqual(["1080"]);
    expect(row(rows, "fps").options.map((o) => o.value)).toEqual([15, 30, 60]);
    expect(checked(row(rows, "fps"))).toEqual([30]);
  });

  it("the sound row follows the stream and is usable where the system can carry it", () => {
    expect(row(streamMenu(screen, "win32"), "audio")).toMatchObject({ checked: true, blocked: null });
    expect(row(streamMenu({ ...screen, audio: false }, "darwin"), "audio")).toMatchObject({ checked: false, blocked: null });
  });

  it("the sound row is blocked, and unchecked, where it cannot work: another OS, or a camera", () => {
    expect(row(streamMenu(screen, "linux"), "audio")).toEqual({ id: "audio", kind: "check", checked: false, blocked: "os" });
    expect(row(streamMenu({ ...camera, audio: true }, "win32"), "audio")).toEqual({ id: "audio", kind: "check", checked: false, blocked: "device" });
  });
});
