import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IconButton } from "./IconButton";
import { Segmented } from "./Segmented";

const icon = createElement("svg", { id: "ic" });
const render = (withIcon: boolean) =>
  renderToStaticMarkup(
    createElement(Segmented, {
      name: "tri",
      value: "inherit",
      onChange: () => {},
      options: [
        { value: "allow", label: "Cho phép", icon: withIcon ? icon : undefined },
        { value: "inherit", label: "Mặc định", icon: withIcon ? icon : undefined },
      ],
    }),
  );

describe("Segmented with icons", () => {
  it("keeps each option's word as the radio's accessible name and hides the icon from readers", () => {
    const html = render(true);
    expect(html).toContain('aria-label="Cho phép"');
    expect(html).toContain('aria-label="Mặc định"');
    expect(html).toContain('aria-hidden="true" class="flex"');
    expect(html).not.toMatch(/>Cho phép</); // no visible word, the icon speaks
  });
  it("text options stay plain text without an aria-label", () => {
    const html = render(false);
    expect(html).toMatch(/>Cho phép</);
    expect(html).not.toContain("aria-label");
  });
});

describe("IconButton", () => {
  it("is a button named by its label, with the glyph hidden", () => {
    const html = renderToStaticMarkup(createElement(IconButton, { icon, label: "Xoá quy tắc a", tip: "Xoá" }));
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Xoá quy tắc a"');
    expect(html).toContain('aria-hidden="true"');
  });
});
