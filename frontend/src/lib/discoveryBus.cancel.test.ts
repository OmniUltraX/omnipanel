import { describe, expect, it, vi } from "vitest";

type ListenHandler = (event: { payload: { taskId?: string } }) => void;

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn<(...args: unknown[]) => Promise<() => void>>(
    async () => () => undefined,
  ),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import { watchDiscoveryCancellation } from "./discoveryBus";
import { isDiscoverySkip } from "./discoveryScope";

describe("discoveryBus cancel watch", () => {
  it("taskId 匹配时触发 onCancel", async () => {
    let handler: ListenHandler | undefined;
    listenMock.mockImplementation(async (_name, cb) => {
      handler = cb as ListenHandler;
      return () => undefined;
    });
    const onCancel = vi.fn();
    const unlisten = await watchDiscoveryCancellation("task-1", onCancel);
    handler?.({ payload: { taskId: "task-1" } });
    handler?.({ payload: { taskId: "other" } });
    expect(onCancel).toHaveBeenCalledTimes(1);
    unlisten();
  });

  it("cancelled skip payload 可识别", () => {
    expect(isDiscoverySkip({ skipped: true, reason: "cancelled" })).toBe(true);
    expect(isDiscoverySkip({ skipped: true, reason: "prod" })).toBe(true);
  });
});
