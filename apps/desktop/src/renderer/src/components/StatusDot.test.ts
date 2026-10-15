import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusDot } from "./StatusDot";

const html = (status: "online" | "idle" | "dnd" | "offline", labelled = true) => renderToStaticMarkup(createElement(StatusDot, { status, labelled }));

describe("StatusDot", () => {
  it("has a different shape per status, not only a different colour", () => {
    expect(html("online")).toContain("bg-presence-on");
    expect(html("idle")).toContain("<svg"); // the crescent
    expect(html("dnd")).toContain("bg-presence-dnd");
    expect(html("dnd")).toContain("bg-surface-0"); // the bar
    expect(html("offline")).toContain("border-2");
    expect(html("offline")).not.toContain("bg-presence");
  });

  it("is labelled for screen readers unless the text sits next to it", () => {
    expect(html("idle")).toContain('<span class="sr-only">Vắng mặt</span>');
    expect(html("dnd", false)).not.toContain("sr-only");
  });
});
