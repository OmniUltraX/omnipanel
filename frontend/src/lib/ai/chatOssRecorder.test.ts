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
  appendChatOssEvent,
  buildChatOssObjectKey,
  CHAT_OSS_FORMAT,
  encodeChatOssEventLine,
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

  it("encodeChatOssEventLine 为 NDJSON 且带 v=1", () => {
    expect(JSON.parse(encodeChatOssEventLine({ t: "content", text: "hi" }))).toEqual({
      v: 1,
      t: "content",
      text: "hi",
    });
    expect(
      JSON.parse(
        encodeChatOssEventLine({
          t: "tool_call",
          id: "c1",
          name: "bash",
          arguments: "{}",
        }),
      ),
    ).toMatchObject({ v: 1, t: "tool_call", id: "c1", name: "bash" });
  });

  it("每 5 秒经 STS 上传结构化事件分片", async () => {
    vi.useFakeTimers();
    startChatOssRecording("conv-1");
    appendChatOssEvent({ t: "user", text: "你好" });
    appendChatOssEvent({ t: "reasoning", text: "想一下" });
    appendChatOssEvent({ t: "content", text: "hello" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(commands.assistantUploadOssText).toHaveBeenCalledTimes(1);
    const req = vi.mocked(commands.assistantUploadOssText).mock.calls[0]![0]!;
    expect(req.token).toBe("tok-1");
    expect(req.objectKey).toBe(
      "omniminiapp/agent_chat_message/user1/conv-1/0.txt",
    );
    expect(req.contents).toContain(`# format=${CHAT_OSS_FORMAT}`);
    expect(req.contents).toContain(
      encodeChatOssEventLine({ t: "user", text: "你好" }),
    );
    expect(req.contents).toContain(
      encodeChatOssEventLine({ t: "reasoning", text: "想一下" }),
    );
    expect(req.contents).toContain(
      encodeChatOssEventLine({ t: "content", text: "hello" }),
    );

    appendChatOssEvent({
      t: "tool_call",
      id: "tc1",
      name: "omni_ssh",
      arguments: "{\"cmd\":\"ls\"}",
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(commands.assistantUploadOssText).toHaveBeenCalledTimes(2);
    const req2 = vi.mocked(commands.assistantUploadOssText).mock.calls[1]![0]!;
    expect(req2.objectKey).toMatch(/\/1\.txt$/);
    expect(req2.contents).toContain("\"t\":\"tool_call\"");

    await stopChatOssRecording();
    vi.useRealTimers();
  });

  it("结束时刷新剩余缓冲", async () => {
    startChatOssRecording("conv-2");
    appendChatOssEvent({ t: "content", text: "tail" });
    await stopChatOssRecording();
    expect(commands.assistantUploadOssText).toHaveBeenCalledTimes(1);
    const req = vi.mocked(commands.assistantUploadOssText).mock.calls[0]![0]!;
    expect(req.objectKey).toBe(
      "omniminiapp/agent_chat_message/user1/conv-2/0.txt",
    );
    expect(req.contents).toContain("\"t\":\"content\"");
    expect(req.contents).toContain("tail");
  });
});
