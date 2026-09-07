import { describe, expect, it, vi } from "vitest";
import { createTabSessionService } from "./createTabSessionService";

describe("createTabSessionService", () => {
  it("list / dispose / onModuleEvicted 语义", async () => {
    const closeTab = vi.fn();
    const svc = createTabSessionService({
      listIds: () => ["a", "b"],
      disposeId: closeTab,
    });
    expect(svc.list().map((s) => s.id)).toEqual(["a", "b"]);
    await svc.dispose("a");
    expect(closeTab).toHaveBeenCalledWith("a");
    closeTab.mockClear();
    svc.onModuleEvicted?.();
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("bindView 发出 bound，unbind 发出 unbound", () => {
    const svc = createTabSessionService({
      listIds: () => ["x"],
      disposeId: () => undefined,
    });
    const events: unknown[] = [];
    const unbind = svc.bindView("x", { push: (e) => events.push(e) });
    expect(events.some((e) => (e as { type: string }).type === "bound")).toBe(true);
    unbind();
    expect(events.some((e) => (e as { type: string }).type === "unbound")).toBe(true);
  });
});
