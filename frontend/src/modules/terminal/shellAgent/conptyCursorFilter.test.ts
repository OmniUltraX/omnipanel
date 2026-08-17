import { describe, expect, it } from "vitest";
import {
  hasConptyScreenReset,
  stripConptyCursorRestore,
  type ConptyCursorRewriteContext,
} from "./conptyCursorFilter";

describe("stripConptyCursorRestore", () => {
  it("CUP/HVP 改到当前行：列1 变 CR，去掉 CUU", () => {
    expect(stripConptyCursorRestore("\x1b[12;1HGet-Date\r\n")).toBe("\rGet-Date\r\n");
    expect(stripConptyCursorRestore("\x1b[H\x1b[2Ahello")).toBe("\rhello");
    expect(stripConptyCursorRestore("\x1b[1;1fPS C:\\Users\\chaoj> ")).toBe(
      "\rPS C:\\Users\\chaoj> ",
    );
  });

  it("CUP 非首列改为当前行 CHA，便于 PSReadLine 把光标放到输入末尾", () => {
    expect(stripConptyCursorRestore("\x1b[8;24H")).toBe("\x1b[24G");
  });

  it("保留光标下移和清行", () => {
    expect(stripConptyCursorRestore("\x1b[2B\x1b[Kdone")).toBe("\x1b[2B\x1b[Kdone");
  });

  it("cls/clear 的擦屏 + 回原点原样保留", () => {
    expect(stripConptyCursorRestore("\x1b[2J\x1b[H")).toBe("\x1b[2J\x1b[H");
    expect(stripConptyCursorRestore("\x1b[H\x1b[2J")).toBe("\x1b[H\x1b[2J");
    expect(stripConptyCursorRestore("\x1b[3J\x1b[HPS> ")).toBe("\x1b[3J\x1b[HPS> ");
  });
});

describe("hasConptyScreenReset", () => {
  it("只有 2J/3J 算真清屏，J/0J/1J 是行内擦除", () => {
    expect(hasConptyScreenReset("\x1b[2J\x1b[H")).toBe(true);
    expect(hasConptyScreenReset("\x1b[3J")).toBe(true);
    expect(hasConptyScreenReset("\x1b[JGet-Process")).toBe(false);
    expect(hasConptyScreenReset("\x1b[0J")).toBe(false);
    expect(hasConptyScreenReset("\x1b[1J")).toBe(false);
    expect(hasConptyScreenReset("\x1b[12;1H\x1b[Kcmd")).toBe(false);
  });
});

describe("stripConptyCursorRestore 按卡片底拦截", () => {
  const belowCards: ConptyCursorRewriteContext = {
    cardsBottomAbs: 20,
    viewportY: 0,
    cursorAbs: 24,
    viewportRows: 24,
  };

  it("光标已在卡下时丢掉落进占位的 CUP，避免 :22 甩到 PS> 后面", () => {
    expect(stripConptyCursorRestore("\x1b[12;1HGet-Process", belowCards)).toBe(
      "Get-Process",
    );
    expect(stripConptyCursorRestore("11:25\x1b[8;22H:22", belowCards)).toBe(
      "11:25:22",
    );
  });

  it("光标还在卡内时，CUP 跳到卡下一行列 1", () => {
    const inCards: ConptyCursorRewriteContext = {
      cardsBottomAbs: 20,
      viewportY: 0,
      cursorAbs: 12,
      viewportRows: 24,
    };
    expect(stripConptyCursorRestore("\x1b[12;1Hcmd", inCards)).toBe(
      "\x1b[21;1Hcmd",
    );
    expect(stripConptyCursorRestore("11:25\x1b[8;22H:22", inCards)).toBe(
      "11:25:22",
    );
  });

  it("CUP 在卡下 → 原样放行，命令在卡下换行", () => {
    expect(stripConptyCursorRestore("\x1b[22;1HGet-Process", belowCards)).toBe(
      "\x1b[22;1HGet-Process",
    );
    expect(stripConptyCursorRestore("\x1b[21;5H", belowCards)).toBe("\x1b[21;5H");
  });

  it("PSReadLine 重绘常用的擦下方（J）不能让整段 CUP 放行", () => {
    expect(stripConptyCursorRestore("\x1b[12;1H\x1b[JGet-Process", belowCards)).toBe(
      "\x1b[JGet-Process",
    );
  });

  it("CUU 会进卡内则夹紧到卡底，卡下的上移保留", () => {
    expect(stripConptyCursorRestore("\x1b[10A", belowCards)).toBe("\x1b[4A");
    expect(stripConptyCursorRestore("\x1b[2A", belowCards)).toBe("\x1b[2A");
  });

  it("1J 擦上方会清掉卡片行，直接丢掉", () => {
    expect(stripConptyCursorRestore("\x1b[1Jtext", belowCards)).toBe("text");
  });

  it("卡片已滚进 scrollback 时视口内 CUP 全部放行", () => {
    const scrolled: ConptyCursorRewriteContext = {
      cardsBottomAbs: 20,
      viewportY: 40,
      cursorAbs: 63,
    };
    expect(stripConptyCursorRestore("\x1b[5;1HGet-Process", scrolled)).toBe(
      "\x1b[5;1HGet-Process",
    );
  });
});
