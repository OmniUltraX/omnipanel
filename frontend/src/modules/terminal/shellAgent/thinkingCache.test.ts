import { describe, expect, it } from "vitest";
import {
  buildAgreedCmdFrozenHtml,
  buildRejectedCmdFrozenHtml,
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
            <button type="button" class="term-shell-agent-btn term-shell-agent-btn--primary">同意并执行</button>
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
    expect(out!).not.toContain("编辑命令");
    expect(out!).not.toContain("待确认");
  });
});
