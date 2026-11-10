import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { NotificationDrawer } from "./NotificationDrawer";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("NotificationDrawer", () => {
  it("does not ship demo alerts for staging-worker / prod-web-01 / example.com", () => {
    render(<NotificationDrawer />);
    window.dispatchEvent(new Event("toggle-notif-drawer"));
    expect(screen.getByText("暂无通知")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/staging-worker/);
    expect(document.body.textContent).not.toMatch(/prod-web-01/);
    expect(document.body.textContent).not.toMatch(/api\.example\.com/);
  });
});
