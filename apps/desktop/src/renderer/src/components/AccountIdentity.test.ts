import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ACCOUNT_TRIGGER_SIZE, AccountIdentity, accountMenuLabel } from "./AccountIdentity";

const long = "a-very-long-display-name-that-would-never-fit-in-the-channel-column";

describe("account strip identity", () => {
  it("truncates a long name and status instead of overflowing", () => {
    const html = renderToStaticMarkup(createElement(AccountIdentity, { id: "u1", username: long, status: "Đang hoạt động ".repeat(10) }));
    expect(html.match(/block truncate/g)).toHaveLength(2);
    expect(html).toContain('class="min-w-0 flex-1"');
  });

  it("lets the grid button shrink its track so truncation can happen", () => {
    expect(ACCOUNT_TRIGGER_SIZE).toContain("grid-cols-[minmax(0,1fr)]");
  });

  it("names the button (and so its tooltip) with the full username", () => {
    expect(accountMenuLabel(long)).toContain(long);
    expect(accountMenuLabel(long)).toContain("Menu tài khoản");
  });
});
