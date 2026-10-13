import { describe, expect, it, vi } from "vitest";
import { blockFileNavigation, hasFiles, isLayoutDrag, LAYOUT_DRAG, nameForPasted, pastedFiles } from "./drop";

const file = (name: string, type: string) => new File(["x"], name, { type });

describe("hasFiles", () => {
  it("is true for file drags only", () => {
    expect(hasFiles({ types: ["Files"] })).toBe(true);
    expect(hasFiles({ types: ["text/plain", "Files"] })).toBe(true);
    expect(hasFiles({ types: ["text/plain"] })).toBe(false);
    expect(hasFiles(null)).toBe(false);
  });
});

describe("internal layout drags vs file drags", () => {
  it("a channel/category drag carries only its own type, so it is never a file drag (no overlay, no upload)", () => {
    const internal = { types: [LAYOUT_DRAG] };
    expect(isLayoutDrag(internal)).toBe(true);
    expect(hasFiles(internal)).toBe(false);
  });
  it("a file drag is never a layout drag (the channel column leaves it alone)", () => {
    expect(isLayoutDrag({ types: ["Files"] })).toBe(false);
    expect(isLayoutDrag({ types: ["text/plain"] })).toBe(false);
    expect(isLayoutDrag(null)).toBe(false);
  });
});

describe("pastedFiles", () => {
  it("returns the files of a pasted image or file", () => {
    const f = file("image.png", "image/png");
    expect(pastedFiles({ types: ["Files"], files: [f] })).toEqual([f]);
  });
  it("leaves plain text alone (no files)", () => {
    expect(pastedFiles({ types: ["text/plain"], files: [] })).toEqual([]);
    expect(pastedFiles(null)).toEqual([]);
  });
  it("leaves a paste with HTML alone (cells copied from a spreadsheet come with an image of them)", () => {
    expect(pastedFiles({ types: ["text/plain", "text/html", "Files"], files: [file("image.png", "image/png")] })).toEqual([]);
  });
});

describe("nameForPasted", () => {
  it("names a pasted screenshot anh-dan.png, numbering several", () => {
    expect(nameForPasted(file("image.png", "image/png"), 0).name).toBe("anh-dan.png");
    expect(nameForPasted(file("image.png", "image/png"), 1).name).toBe("anh-dan-2.png");
    expect(nameForPasted(file("", "image/jpeg"), 0).name).toBe("anh-dan.jpg");
  });
  it("keeps the type and the bytes", async () => {
    const renamed = nameForPasted(file("image.png", "image/png"), 0);
    expect(renamed.type).toBe("image/png");
    expect(await renamed.text()).toBe("x");
  });
  it("keeps a real file name, and non-images", () => {
    const named = file("ky-niem.png", "image/png");
    expect(nameForPasted(named, 0)).toBe(named);
    const pdf = file("", "application/pdf");
    expect(nameForPasted(pdf, 0)).toBe(pdf);
  });
});

describe("blockFileNavigation", () => {
  it("prevents the default of dragover and drop on the window, and can be undone", () => {
    const handlers = new Map<string, (e: Event) => void>();
    const target = {
      addEventListener: (type: string, fn: (e: Event) => void) => void handlers.set(type, fn),
      removeEventListener: (type: string) => void handlers.delete(type),
    };
    const off = blockFileNavigation(target);
    for (const type of ["dragover", "drop"]) {
      const e = { preventDefault: vi.fn() } as unknown as Event;
      handlers.get(type)!(e);
      expect(e.preventDefault).toHaveBeenCalled();
    }
    off();
    expect(handlers.size).toBe(0);
  });
});
