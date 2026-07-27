import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    assistantUploadOssText: vi.fn(async () => ({
      status: "ok",
      data: { objectKey: "k", etag: null, bytes: 1 },
    })),
  },
}));

vi.mock("../../stores/userProfileStore", () => ({
  useUserProfileStore: {
    getState: () => ({
      ossPath: "omniminiapp/agent_chat_message/user1",
    }),
  },
}));

vi.mock("../../stores/authStore", () => ({
  useAuthStore: {
    getState: () => ({ token: "tok-1" }),
  },
}));

import { commands } from "../../ipc/bindings";
import {
  appendChatOssChunk,
  buildChatOssObjectKey,
  startChatOssRecording,
  stopChatOssRecording,
} from "./chatOssRecorder";

describe("chatOssRecorder", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(commands.assistantUploadOssText).mockClear();
  });

  it("buildChatOssObjectKey 使用 posix 路径", () => {
    expect(
      buildChatOssObjectKey("omniminiapp/agent_chat_message/u1", "conv-1", 0),
    ).toBe("omniminiapp/agent_chat_message/u1/conv-1/0.txt");
  });

  it("每 5 秒经 STS 上传递增编号文件", async () => {
    vi.useFakeTimers();
    startChatOssRecording("conv-1");
    appendChatOssChunk("hello");
    await vi.advanceTimersByTimeAsync(5000);
    expect(commands.assistantUploadOssText).toHaveBeenCalledTimes(1);
    const req = vi.mocked(commands.assistantUploadOssText).mock.calls[0]![0]!;
    expect(req.token).toBe("tok-1");
    expect(req.objectKey).toBe(
      "omniminiapp/agent_chat_message/user1/conv-1/0.txt",
    );
    expect(req.contents).toContain("hello");
    expect(req.contents).toContain("conversation=conv-1");

    appendChatOssChunk(" world");
    await vi.advanceTimersByTimeAsync(5000);
    expect(commands.assistantUploadOssText).toHaveBeenCalledTimes(2);
    const req2 = vi.mocked(commands.assistantUploadOssText).mock.calls[1]![0]!;
    expect(req2.objectKey).toMatch(/\/1\.txt$/);

    await stopChatOssRecording();
    vi.useRealTimers();
  });

  it("结束时刷新剩余缓冲", async () => {
    startChatOssRecording("conv-2");
    appendChatOssChunk("tail");
    await stopChatOssRecording();
    expect(commands.assistantUploadOssText).toHaveBeenCalledTimes(1);
    const req = vi.mocked(commands.assistantUploadOssText).mock.calls[0]![0]!;
    expect(req.objectKey).toBe(
      "omniminiapp/agent_chat_message/user1/conv-2/0.txt",
    );
    expect(req.contents).toContain("tail");
  });
});
