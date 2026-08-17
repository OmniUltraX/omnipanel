import { afterEach, describe, expect, it } from "vitest";
import { shouldFocusTerminalOnClick } from "./terminalClickFocus";

describe("shouldFocusTerminalOnClick", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("点终端空白 / xterm / 思考完成卡要拉回输入", () => {
    document.body.innerHTML = `
      <div class="term-pane">
        <div class="terminal-area" id="area"></div>
        <textarea class="xterm-helper-textarea" id="xterm"></textarea>
        <div class="term-shell-agent-card is-done" id="think" role="button"></div>
      </div>
    `;
    expect(shouldFocusTerminalOnClick(document.getElementById("area"))).toBe(true);
    expect(shouldFocusTerminalOnClick(document.getElementById("xterm"))).toBe(true);
    expect(shouldFocusTerminalOnClick(document.getElementById("think"))).toBe(true);
  });

  it("点按钮、命令输入、待确认卡不抢焦点", () => {
    document.body.innerHTML = `
      <div class="term-pane">
        <button id="btn" type="button">展开</button>
        <textarea class="term-cmd-textarea" id="cmd"></textarea>
        <div class="term-shell-agent-card term-shell-agent-card--cmd is-pending" id="confirm">待确认</div>
      </div>
    `;
    expect(shouldFocusTerminalOnClick(document.getElementById("btn"))).toBe(false);
    expect(shouldFocusTerminalOnClick(document.getElementById("cmd"))).toBe(false);
    expect(shouldFocusTerminalOnClick(document.getElementById("confirm"))).toBe(false);
  });
});
