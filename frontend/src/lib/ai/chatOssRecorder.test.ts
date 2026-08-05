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
  aggregateChatOssEvent,
  appendChatOssEvent,
  buildChatOssObjectKey,
  CHAT_OSS_FORMAT,
  CHAT_OSS_SECTION_TAGS,
  encodeChatOssSection,
  encodeChatOssSections,
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

  it("分隔符标签与 chat_log 对齐约定一致", () => {
    expect(CHAT_OSS_SECTION_TAGS).toEqual({
      user: "user_message",
      reasoning: "ai_reasoning",
      content: "ai___message",
      tool_call: "tool_calling",
      tool_result: "tool___result",
      plan: "plan________",
      error: "error______",
    });
  });

  it("同类型增量聚合为一段", () => {
    let sections = aggregateChatOssEvent([], { t: "content", text: "A" });
    sections = aggregateChatOssEvent(sections, { t: "content", text: "B" });
    sections = aggregateChatOssEvent(sections, { t: "reasoning", text: "r1" });
    sections = aggregateChatOssEvent(sections, { t: "reasoning", text: "r2" });
    expect(sections).toEqual([
      { kind: "content", text: "AB" },
      { kind: "reasoning", text: "r1r2" },
    ]);
  });

  it("同 id 的 tool_call 覆盖为最新快照", () => {
    let sections = aggregateChatOssEvent([], {
      t: "tool_call",
      id: "c1",
      name: "bash",
      arguments: '{"a":1}',
    });
    sections = aggregateChatOssEvent(sections, {
      t: "tool_call",
      id: "c1",
      name: "bash",
      arguments: '{"a":12}',
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toEqual({
      kind: "tool_call",
      items: [{ id: "c1", name: "bash", arguments: '{"a":12}' }],
    });
  });

  it("不同 id 的连续 tool_call 聚成一段多行 JSON", () => {
    let sections = aggregateChatOssEvent([], {
      t: "tool_call",
      id: "c0",
      name: "omni_docker_list_containers",
      arguments: "",
    });
    sections = aggregateChatOssEvent(sections, {
      t: "tool_call",
      id: "c1",
      name: "omni_docker_list_containers",
      arguments: "",
    });
    sections = aggregateChatOssEvent(sections, {
      t: "tool_call",
      id: "c0",
      name: "omni_docker_list_containers",
      arguments: '{"filter":"all"}',
    });
    sections = aggregateChatOssEvent(sections, {
      t: "tool_result",
      id: "c0",
      status: "failed",
      result: "err",
    });
    sections = aggregateChatOssEvent(sections, {
      t: "tool_call",
      id: "c1",
      name: "omni_docker_list_containers",
      arguments: '{"filter":"all"}',
    });

    expect(sections).toHaveLength(3);
    expect(sections[0]).toEqual({
      kind: "tool_call",
      items: [
        { id: "c0", name: "omni_docker_list_containers", arguments: '{"filter":"all"}' },
        { id: "c1", name: "omni_docker_list_containers", arguments: "" },
      ],
    });
    expect(sections[1]).toEqual({
      kind: "tool_result",
      items: [{ id: "c0", status: "failed", result: "err" }],
    });
    expect(sections[2]).toEqual({
      kind: "tool_call",
      items: [
        { id: "c1", name: "omni_docker_list_containers", arguments: '{"filter":"all"}' },
      ],
    });

    const encoded = encodeChatOssSections([sections[0]!]);
    expect(encoded.match(/\|\[tool_calling\]\|/g)).toHaveLength(1);
    expect(encoded).toContain(
      '{"id":"c0","name":"omni_docker_list_containers","arguments":"{\\"filter\\":\\"all\\"}"}',
    );
    expect(encoded).toContain(
      '{"id":"c1","name":"omni_docker_list_containers","arguments":""}',
    );
  });

  it("同 id 的 plan 覆盖为最新快照并编码为 plan________", () => {
    const planA = {
      id: "plan_1",
      title: "检查",
      steps: [{ id: "s1", title: "uptime", status: "pending" as const }],
      status: "executing" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const planB = {
      ...planA,
      updatedAt: 2,
      steps: [{ id: "s1", title: "uptime", status: "completed" as const }],
      status: "completed" as const,
    };
    let sections = aggregateChatOssEvent([], { t: "plan", plan: planA });
    sections = aggregateChatOssEvent(sections, { t: "plan", plan: planB });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toEqual({ kind: "plan", items: [planB] });

    const encoded = encodeChatOssSections(sections);
    expect(encoded).toContain("|[plan________]|");
    expect(encoded).toContain('"id":"plan_1"');
    expect(encoded).toContain('"status":"completed"');
  });

  it("encodeChatOssSections 使用对齐标签与分隔符", () => {
    const encoded = encodeChatOssSections([
      { kind: "user", text: "你好" },
      { kind: "content", text: "hello" },
      {
        kind: "tool_call",
        items: [{ id: "c1", name: "bash", arguments: "{}" }],
      },
    ]);
    expect(encoded).toContain(encodeChatOssSection(CHAT_OSS_SECTION_TAGS.user, "你好"));
    expect(encoded).toContain(
      encodeChatOssSection(CHAT_OSS_SECTION_TAGS.content, "hello"),
    );
    expect(encoded).toContain("|[tool_calling]|");
    expect(encoded).toContain('{"id":"c1","name":"bash","arguments":"{}"}');
    expect(encoded).not.toContain('"t":"content"');
  });

  it("每 3 秒经 STS 上传聚合后的分隔符分片", async () => {
    vi.useFakeTimers();
    startChatOssRecording("conv-1");
    appendChatOssEvent({ t: "user", text: "你好" });
    appendChatOssEvent({ t: "reasoning", text: "想" });
    appendChatOssEvent({ t: "reasoning", text: "一下" });
    appendChatOssEvent({ t: "content", text: "hel" });
    appendChatOssEvent({ t: "content", text: "lo" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(commands.assistantUploadOssText).toHaveBeenCalledTimes(1);
    const req = vi.mocked(commands.assistantUploadOssText).mock.calls[0]![0]!;
    expect(req.token).toBe("tok-1");
    expect(req.objectKey).toBe(
      "omniminiapp/agent_chat_message/user1/conv-1/0.txt",
    );
    expect(req.contents).toContain(`# format=${CHAT_OSS_FORMAT}`);
    expect(req.contents).toContain("|[user_message]|");
    expect(req.contents).toContain("你好");
    expect(req.contents).toContain("|[ai_reasoning]|");
    expect(req.contents).toContain("想一下");
    expect(req.contents).toContain("|[ai___message]|");
    expect(req.contents).toContain("hello");
    // 聚合后不应再出现 NDJSON 事件行
    expect(req.contents).not.toContain('"t":"content"');

    appendChatOssEvent({
      t: "tool_call",
      id: "tc1",
      name: "omni_ssh",
      arguments: "{\"cmd\":\"ls\"}",
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(commands.assistantUploadOssText).toHaveBeenCalledTimes(2);
    const req2 = vi.mocked(commands.assistantUploadOssText).mock.calls[1]![0]!;
    expect(req2.objectKey).toMatch(/\/1\.txt$/);
    expect(req2.contents).toContain("|[tool_calling]|");
    expect(req2.contents).toContain('"name":"omni_ssh"');

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
    expect(req.contents).toContain("|[ai___message]|");
    expect(req.contents).toContain("tail");
  });
});
