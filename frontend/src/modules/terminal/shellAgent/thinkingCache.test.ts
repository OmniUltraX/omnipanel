import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgreedCmdFrozenHtml,
  buildRejectedCmdFrozenHtml,
  buildThinkingDoneFrozenHtml,
  clearShellAgentLastCmd,
  clearShellAgentThinkingFull,
  clearArchivedDisplayToolIds,
  collectDisplayToolIdsFromHtml,
  extractThinkingFromLiveHtml,
  getArchivedDisplayToolIds,
  getShellAgentLastCmd,
  getShellAgentThinkingFull,
  markArchivedDisplayToolIds,
  mergeThinkingText,
  readFrozenThinkingFromCard,
  setShellAgentLastCmd,
  setShellAgentThinkingFull,
  transformPendingConfirmToAgreedHtml,
  transformPendingConfirmToRejectedHtml,
} from "./thinkingCache";

const PENDING_LIVE = `
      <div class="term-shell-agent-card term-shell-agent-card--cmd is-pending">
        <div class="term-shell-agent-card__head">
          <span class="term-shell-agent-ico term-shell-agent-ico--ai">AI</span>
          <span class="term-shell-agent-card__status-label accent">待确认</span>
          <span class="term-shell-agent-card__head-spacer"></span>
          <span class="term-shell-agent-card__head-meta">将在主机执行</span>
        </div>
        <div class="term-shell-agent-card__body">
          <p class="term-shell-agent-card__desc">可执行命令： date</p>
          <pre class="term-shell-agent-card__code"><code>date</code></pre>
          <div class="term-shell-agent-card__actions">
            <button type="button" class="term-shell-agent-btn term-shell-agent-btn--primary">同意并执行<kbd class="term-shell-agent-kbd">Enter</kbd></button>
            <button type="button" class="term-shell-agent-btn">拒绝</button>
            <button type="button" class="term-shell-agent-btn term-shell-agent-btn--ghost">编辑命令</button>
          </div>
        </div>
      </div>`;

describe("agreed confirm freeze", () => {
  it("buildAgreedCmdFrozenHtml 保留说明/命令/操作区，仅状态与主按钮为已同意", () => {
    const html = buildAgreedCmdFrozenHtml({
      sessionId: "s1",
      command: "date",
      toolId: "t1",
      description: "在远程主机上执行 date",
    });
    expect(html).toContain("is-agreed");
    expect(html).toContain("已同意");
    expect(html).toContain("在远程主机上执行 date");
    expect(html).toContain("<code>date</code>");
    expect(html).toContain("将在主机执行");
    expect(html).toContain("term-shell-agent-btn--primary");
    expect(html).not.toContain("拒绝");
    expect(html).not.toContain("编辑命令");
    expect(html).not.toContain("查看");
    expect(html).not.toContain("term-shell-agent-ico--check");
  });

  it("transformPendingConfirmToAgreedHtml 只改顶部状态与主按钮", () => {
    const out = transformPendingConfirmToAgreedHtml(PENDING_LIVE, {
      sessionId: "s1",
      command: "date",
      toolId: "t1",
    });
    expect(out).toBeTruthy();
    expect(out!).toContain("is-agreed");
    expect(out!).toContain(">已同意</span>");
    expect(out!).toContain(">已同意</button>");
    expect(out!).toContain("可执行命令： date");
    expect(out!).toContain("<code>date</code>");
    expect(out!).toContain("将在主机执行");
    expect(out!).not.toContain("拒绝");
    expect(out!).not.toContain("编辑命令");
    expect(out!).not.toContain("待确认");
    expect(out!).not.toContain("同意并执行");
    expect(out!).not.toContain("term-shell-agent-kbd");
  });
});

describe("rejected confirm freeze", () => {
  it("buildRejectedCmdFrozenHtml 同布局，状态与主按钮为已拒绝", () => {
    const html = buildRejectedCmdFrozenHtml({
      sessionId: "s1",
      command: "date",
      toolId: "t1",
      description: "在远程主机上执行 date",
    });
    expect(html).toContain("is-rejected");
    expect(html).toContain("已拒绝");
    expect(html).toContain("未执行");
    expect(html).toContain("在远程主机上执行 date");
    expect(html).toContain("<code>date</code>");
    expect(html).toContain("term-shell-agent-btn--muted");
    expect(html).not.toContain("同意并执行");
    expect(html).not.toContain("编辑命令");
  });

  it("transformPendingConfirmToRejectedHtml 改顶部/主按钮并去掉次要操作", () => {
    const out = transformPendingConfirmToRejectedHtml(PENDING_LIVE, {
      sessionId: "s1",
      command: "date",
      toolId: "t1",
    });
    expect(out).toBeTruthy();
    expect(out!).toContain("is-rejected");
    expect(out!).toContain(">已拒绝</span>");
    expect(out!).toContain("未执行");
    expect(out!).toContain("term-shell-agent-btn--muted");
    expect(out!).toContain("可执行命令： date");
    expect(out!).not.toContain("同意并执行");
    expect(out!).not.toContain("term-shell-agent-kbd");
    expect(out!).not.toContain("编辑命令");
    expect(out!).not.toContain("待确认");
  });
});

describe("lastCmd description", () => {
  afterEach(() => {
    clearShellAgentLastCmd("s1");
  });

  it("换 toolId 且未传 description 时不沿用上一工具旁注", () => {
    setShellAgentLastCmd("s1", {
      command: "a",
      toolId: "t1",
      description: "当前时间是：2026年8月14日 15:51:30",
    });
    setShellAgentLastCmd("s1", { command: "b", toolId: "t2" });
    expect(getShellAgentLastCmd("s1")?.description).toBeUndefined();
  });

  it("同一 toolId 未传 description 时保留旁注", () => {
    setShellAgentLastCmd("s1", { command: "a", toolId: "t1", description: "旁注" });
    setShellAgentLastCmd("s1", { command: "a", toolId: "t1" });
    expect(getShellAgentLastCmd("s1")?.description).toBe("旁注");
  });
});

describe("thinking full cache", () => {
  afterEach(() => {
    clearShellAgentThinkingFull("s1");
  });

  it("空文本不清除缓存，避免归档冻成正在理解意图", () => {
    setShellAgentThinkingFull("s1", "当前时间是：2026年8月14日 15:51:30");
    expect(getShellAgentThinkingFull("s1")).toContain("15:51:30");
    setShellAgentThinkingFull("s1", "  ");
    expect(getShellAgentThinkingFull("s1")).toContain("15:51:30");
  });

  it("短碎片不能覆盖已缓存的思考全文", () => {
    setShellAgentThinkingFull("s1", "用户问现在的时间。我需要用 Get-Date。");
    setShellAgentThinkingFull("s1", "ni_ssh_exec.");
    expect(getShellAgentThinkingFull("s1")).toContain("用户问现在的时间");
    expect(getShellAgentThinkingFull("s1")).toContain("Get-Date");
  });

  it("mergeThinkingText 保留更长全文，新窗口才替换", () => {
    expect(
      mergeThinkingText("用户问现在的时间。我需要用 Get-Date。", "ni_ssh_exec."),
    ).toContain("用户问现在的时间");
    expect(mergeThinkingText("先看 CPU。", "CPU 正常，再看内存。")).toBe(
      "CPU 正常，再看内存。",
    );
    expect(
      mergeThinkingText(
        "CPU 12%，内存 8.1GB。磁盘正常。建议继续观察。",
        "三步巡检已完成! ✅",
      ),
    ).toContain("CPU 12%");
    expect(
      mergeThinkingText(
        '今天 8月17日" 搜索\n搜索结果已经返回了多个链接。',
        "搜索结果已经返回了多个链接。",
      ),
    ).toBe("搜索结果已经返回了多个链接。");
  });

  it("从活卡 HTML 能捞回思考正文", () => {
    const html = buildThinkingDoneFrozenHtml({
      sessionId: "s1",
      fullText: "用户想查看资源占用。",
    });
    expect(extractThinkingFromLiveHtml(html)).toContain("用户想查看资源占用");
  });

  it("冻结思考卡展开能读到全部句子，不只最后一句", () => {
    const html = buildThinkingDoneFrozenHtml({
      sessionId: "s1",
      fullText: "用户想查看资源占用。\n先采样 CPU。\n最后再看内存。",
    });
    const host = document.createElement("div");
    host.innerHTML = html;
    const card = host.querySelector("[data-shell-agent-frozen-thinking]")!;
    const full = readFrozenThinkingFromCard(card);
    expect(full).toContain("用户想查看资源占用");
    expect(full).toContain("先采样 CPU");
    expect(full).toContain("最后再看内存");
  });
});

describe("archived display tool ids", () => {
  afterEach(() => {
    clearArchivedDisplayToolIds("s1");
  });

  it("从工具条 HTML 抽出 data-tool-id，归档后活卡不再重复画", () => {
    const html =
      `<div class="term-shell-agent-tool" data-tool-id="t-search"></div>` +
      `<div class="term-shell-agent-tool" data-tool-id="t-fetch"></div>`;
    expect(collectDisplayToolIdsFromHtml(html)).toEqual(["t-search", "t-fetch"]);
    markArchivedDisplayToolIds("s1", ["t-search"]);
    expect(getArchivedDisplayToolIds("s1").has("t-search")).toBe(true);
    expect(getArchivedDisplayToolIds("s1").has("t-fetch")).toBe(false);
  });
});

