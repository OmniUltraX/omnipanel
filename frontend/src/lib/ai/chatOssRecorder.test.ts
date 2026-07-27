import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    writeTextFile: vi.fn(async () => ({ status: "ok", data: "ok" })),
  },
}));

vi.mock("../../stores/userProfileStore", () => ({
  useUserProfileStore: {
    getState: () => ({ ossPath: "D:/oss-chat" }),
  },
}));

import { commands } from "../../ipc/bindings";
import {
  appendChatOssChunk,
  startChatOssRecording,
  stopChatOssRecording,
} from "./chatOssRecorder";

describe("chatOssRecorder", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(commands.writeTextFile).mockClear();
  });

  it("每 5 秒将缓冲写入递增编号文件", async () => {
    vi.useFakeTimers();
    startChatOssRecording("conv-1");
    appendChatOssChunk("hello");
    await vi.advanceTimersByTimeAsync(5000);
    expect(commands.writeTextFile).toHaveBeenCalledTimes(1);
    const [path, contents] = vi.mocked(commands.writeTextFile).mock.calls[0]!;
    expect(path.replace(/\\/g, "/")).toMatch(/D:\/oss-chat\/\d{8}\/0\.txt$/);
    expect(contents).toContain("hello");
    expect(contents).toContain("conversation=conv-1");

    appendChatOssChunk(" world");
    await vi.advanceTimersByTimeAsync(5000);
    expect(commands.writeTextFile).toHaveBeenCalledTimes(2);
    const [path2] = vi.mocked(commands.writeTextFile).mock.calls[1]!;
    expect(path2.replace(/\\/g, "/")).toMatch(/\/1\.txt$/);

    await stopChatOssRecording();
    vi.useRealTimers();
  });

  it("结束时刷新剩余缓冲", async () => {
    startChatOssRecording("conv-2");
    appendChatOssChunk("tail");
    await stopChatOssRecording();
    expect(commands.writeTextFile).toHaveBeenCalledTimes(1);
    const [, contents] = vi.mocked(commands.writeTextFile).mock.calls[0]!;
    expect(contents).toContain("tail");
  });
});
