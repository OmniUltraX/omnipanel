import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";

vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ locale: "zh-CN" }),
  },
}));
vi.mock("../../../stores/terminalStore", () => ({
  findTerminalPane: vi.fn(() => undefined),
}));

import { findTerminalPane } from "../../../stores/terminalStore";
import { registerXterm, unregisterXterm } from "../xtermRegistry";
import {
  archiveActiveInlineCard,
  beginShellAgentCard,
  cardRowsFor,
  clearShellAgentGeometry,
  disposeShellAgentCard,
  getShellAgentGeometry,
  minCardRowsFor,
  needsBlankLineBeforeMarker,
  reanchorShellAgentCard,
  resizeShellAgentCard,
  setShellAgentCardKind,
  ensureMinCardRows,
  contentHeightToCardRows,
  fitShellAgentCardToContent,
  clipShellAgentDecorationToViewport,
} from "./shellAgentGeometry";
import { clearShellAgentThinkingFull, setShellAgentThinkingFull, getArchivedDisplayToolIds, clearArchivedDisplayToolIds } from "./thinkingCache";

type FakeTerm = {
  cols: number;
  rows: number;
  cursorLine: number;
  currentLine: string;
  writes: string[];
  markers: FakeMarker[];
  decorations: FakeDecoration[];
  buffer: {
    active: {
      baseY: number;
      cursorY: number;
      getLine: (y: number) => { translateToString: (trim?: boolean) => string };
    };
  };
  registerMarker: (offset: number) => IMarker;
  registerDecoration: (opts: { marker: IMarker; height?: number }) => IDecoration | undefined;
  write: (data: string, cb?: () => void) => void;
  failDecoration: boolean;
};

type FakeMarker = {
  line: number;
  isDisposed: boolean;
  disposedCount: number;
  dispose: () => void;
};

type FakeDecoration = {
  marker: IMarker;
  height?: number;
  disposed: boolean;
};

function createFakeTerm(opts?: { cursorY?: number; lineText?: string }): FakeTerm {
  const term: FakeTerm = {
    cols: 80,
    rows: 24,
    cursorLine: opts?.cursorY ?? 0,
    currentLine: opts?.lineText ?? "",
    writes: [],
    markers: [],
    decorations: [],
    failDecoration: false,
    buffer: {
      active: {
        baseY: 0,
        get cursorY() {
          return term.cursorLine;
        },
        getLine() {
          return { translateToString: () => term.currentLine };
        },
      },
    },
    registerMarker() {
      const marker: FakeMarker = {
        line: term.cursorLine,
        isDisposed: false,
        disposedCount: 0,
        dispose() {
          marker.isDisposed = true;
          marker.disposedCount += 1;
        },
      };
      term.markers.push(marker);
      return marker as unknown as IMarker;
    },
    registerDecoration(opts) {
      if (term.failDecoration) return undefined;
      const deco: FakeDecoration = {
        marker: opts.marker,
        height: opts.height,
        disposed: false,
      };
      term.decorations.push(deco);
      return {
        marker: opts.marker,
        element: document.createElement("div"),
        onRender: () => ({ dispose: () => {} }),
        dispose: () => {
          deco.disposed = true;
        },
      } as unknown as IDecoration;
    },
    write(data, cb) {
      term.writes.push(data);
      const n = (data.match(/\r\n/g) ?? []).length;
      term.cursorLine += n;
      if (n > 0) term.currentLine = "";
      if (term.cursorLine >= term.rows) {
        term.cursorLine = term.rows - 1;
      }
      cb?.();
    },
  };
  return term;
}

const SID = "test-geo-session";

describe("shellAgentGeometry", () => {
  beforeEach(() => {
    clearShellAgentGeometry(SID);
    clearShellAgentThinkingFull(SID);
    clearArchivedDisplayToolIds(SID);
    unregisterXterm(SID);
    vi.mocked(findTerminalPane).mockReturnValue(undefined);
  });

  it("minCardRowsFor：thinking 2 行，cmd 6 行起步，final 1 行起步", () => {
    expect(minCardRowsFor("thinking")).toBe(2);
    expect(minCardRowsFor("cmd")).toBe(6);
    expect(minCardRowsFor("final")).toBe(1);
    expect(cardRowsFor("cmd")).toBe(1);
  });

  it("contentHeightToCardRows：thinking 再矮也至少 2 行", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    expect(contentHeightToCardRows(SID, 8, "thinking")).toBeGreaterThanOrEqual(2);
  });

  it("contentHeightToCardRows：确认卡默认至少 6 行", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    expect(contentHeightToCardRows(SID, 36, "cmd")).toBeGreaterThanOrEqual(6);
  });

  it("contentHeightToCardRows：工具条显式 minRows=2 时按内容取行，不抬到确认卡高度", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    const rows = contentHeightToCardRows(SID, 36, "cmd", { minRows: 2, padRows: 0 });
    expect(rows).toBeLessThanOrEqual(3);
    expect(rows).toBeGreaterThanOrEqual(2);
  });

  it("contentHeightToCardRows：final 超高不超过可视行-1，避免画出终端被裁切", () => {
    const term = createFakeTerm();
    term.rows = 24;
    registerXterm(SID, term as unknown as Terminal);
    const rows = contentHeightToCardRows(SID, 4000, "final");
    expect(rows).toBeLessThanOrEqual(23);
    expect(rows).toBeGreaterThan(1);
  });

  it("beginShellAgentCard：thinking 最小 2 行占位 + marker+decoration 就位", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);

    const geo = beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "查一下磁盘",
    });

    expect(geo.mode).toBe("inline");
    expect(geo.rows).toBe(2);
    expect(term.writes.join("")).toBe("\r\n".repeat(2));
    expect(term.markers).toHaveLength(1);
    expect(term.decorations).toHaveLength(1);
    expect(term.decorations[0].height).toBe(2);
  });

  it("beginShellAgentCard：无 term / decoration 注册失败 → detached", () => {
    const noTerm = beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q",
    });
    expect(noTerm.mode).toBe("detached");

    const term = createFakeTerm();
    term.failDecoration = true;
    registerXterm(SID, term as unknown as Terminal);
    const geo = beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q",
    });
    expect(geo.mode).toBe("detached");
    expect(geo.decoration).toBeNull();
  });

  it("resizeShellAgentCard：同 marker 扩高，补写差值占位行", async () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    beginShellAgentCard(SID, {
      kind: "final",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q",
    });
    const writesAfterBegin = term.writes.join("");

    resizeShellAgentCard(SID, 6);

    const geo = getShellAgentGeometry(SID);
    expect(geo?.rows).toBe(6);
    // 原子切换：resize 后 decoration 立刻非空，不出现 null 空窗
    expect(geo?.decoration).not.toBeNull();
    expect(geo?.mode).toBe("inline");
    expect(term.writes.join("").slice(writesAfterBegin.length)).toBe("\r\n".repeat(5));
    expect(term.decorations).toHaveLength(2);
    expect(term.decorations[1].height).toBe(6);
    // marker 复用不重建
    expect(term.markers).toHaveLength(1);
  });

  it("思考卡 fit/resize 不扩行，避免冻结后空白累加", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q",
    });
    const afterBegin = term.writes.join("");

    fitShellAgentCardToContent(SID, 400);
    expect(getShellAgentGeometry(SID)?.rows).toBe(2);
    expect(term.writes.join("")).toBe(afterBegin);

    resizeShellAgentCard(SID, 8);
    expect(getShellAgentGeometry(SID)?.rows).toBe(2);
    expect(term.writes.join("")).toBe(afterBegin);
    expect(term.decorations[0].height).toBe(2);
  });

  it("连续重锚思考卡：每张固定 2 行，补写行数不随轮次累加", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q",
    });

    const newlineCount = () => (term.writes.join("").match(/\r\n/g) ?? []).length;

    term.writes.length = 0;
    reanchorShellAgentCard(SID, "thinking");
    const first = newlineCount();
    expect(first).toBeLessThanOrEqual(3);
    expect(getShellAgentGeometry(SID)?.rows).toBe(2);

    term.writes.length = 0;
    reanchorShellAgentCard(SID, "thinking");
    const second = newlineCount();
    expect(second).toBe(first);
    expect(getShellAgentGeometry(SID)?.rows).toBe(2);
  });

  it("思考卡换确认卡：先撑到确认卡最小占位", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q",
    });
    expect(getShellAgentGeometry(SID)?.rows).toBe(2);
    setShellAgentCardKind(SID, "cmd");
    ensureMinCardRows(SID, "cmd");
    expect(getShellAgentGeometry(SID)?.cardKind).toBe("cmd");
    expect(getShellAgentGeometry(SID)?.rows).toBe(6);
  });

  it("续轮确认卡：光标已过占位不再加高，避免盖住回显", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q",
    });
    expect(getShellAgentGeometry(SID)?.rows).toBe(6);
    term.cursorLine = 40;
    resizeShellAgentCard(SID, 12);
    expect(getShellAgentGeometry(SID)?.rows).toBe(6);
  });

  it("disposeShellAgentCard：撤卡留占位，几何归零", async () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q",
    });

    disposeShellAgentCard(SID);

    const geo = getShellAgentGeometry(SID);
    expect(geo?.mode).toBe("idle");
    expect(geo?.cardKind).toBeNull();
    expect(geo?.decoration).toBeNull();
    expect(geo?.rows).toBe(0);

    // dispose 延后到 portal idle，避免与 React removeChild 竞态
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });
    });
    expect(term.decorations[0].disposed).toBe(true);
  });

  it("archiveActiveInlineCard：有思考正文时归档不 dispose", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q",
    });
    setShellAgentThinkingFull(SID, "先看 CPU 占用");

    archiveActiveInlineCard(SID);

    const geo = getShellAgentGeometry(SID);
    expect(geo?.mode).toBe("idle");
    expect(term.decorations.some((d) => !d.disposed)).toBe(true);
  });

  it("archiveActiveInlineCard：无思考正文不冻空的思考完成卡", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q",
    });

    archiveActiveInlineCard(SID);

    expect(getShellAgentGeometry(SID)?.mode).toBe("idle");
    expect(term.decorations[0].disposed).toBe(true);
  });

  it("续轮建卡：光标仍在归档卡内时先换行再钉，避免 decoration 重叠", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q1",
    });
    const firstMarkerLine = (term.markers[0] as FakeMarker).line;
    archiveActiveInlineCard(SID);

    // 模拟 ConPTY 把光标 CUP 回已归档确认卡内部
    term.cursorLine = firstMarkerLine;

    const geo = beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q2",
    });
    const secondMarkerLine = (term.markers[1] as FakeMarker).line;
    expect(geo.mode).toBe("inline");
    expect(secondMarkerLine).toBeGreaterThanOrEqual(firstMarkerLine + 1);
    const liveDecorations = term.decorations.filter((d) => !d.disposed);
    expect(liveDecorations).toHaveLength(2);
  });

  it("贴底且当前行有命令时，先换行再钉卡，避免 decoration 盖住回显", () => {
    const term = createFakeTerm({
      cursorY: 23,
      lineText: 'Get-Counter "\\Processor(_Total)\\% Processor Time"',
    });
    registerXterm(SID, term as unknown as Terminal);
    expect(needsBlankLineBeforeMarker(term as unknown as Terminal)).toBe(true);

    const geo = beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "PS> ",
      query: "看资源",
    });

    expect(geo.mode).toBe("inline");
    expect(geo.rows).toBe(6);
    // 先空一行，再写确认卡占位
    expect(term.writes[0]).toBe("\r\n");
    expect(term.writes.join("")).toBe("\r\n".repeat(7));
    expect(term.currentLine).toBe("");
  });

  it("reanchor 贴底时同样先空行再钉", () => {
    const term = createFakeTerm({
      cursorY: 23,
      lineText: "PS C:\\Users\\chaoj>",
    });
    registerXterm(SID, term as unknown as Terminal);
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "PS> ",
      query: "q",
    });
    term.cursorLine = 23;
    term.currentLine = "Get-Volume | Where-Object {$_.DriveType -eq 'Fixed'}";
    term.writes.length = 0;

    reanchorShellAgentCard(SID, "cmd");

    expect(getShellAgentGeometry(SID)?.cardKind).toBe("cmd");
    const newlines = (term.writes.join("").match(/\r\n/g) ?? []).length;
    expect(newlines).toBeGreaterThanOrEqual(7);
  });

  it("reanchor 冻结工具条时记下 tool id，避免 search 再画一次", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "历史上的今天",
    });
    const live = getShellAgentGeometry(SID)?.decoration?.element;
    expect(live).toBeTruthy();
    live!.innerHTML =
      '<div class="term-shell-agent-tool" data-tool-id="t-search"></div>';

    reanchorShellAgentCard(SID, "thinking");

    expect(getArchivedDisplayToolIds(SID).has("t-search")).toBe(true);
    expect(getShellAgentGeometry(SID)?.cardKind).toBe("thinking");
  });

  it("clipShellAgentDecorationToViewport：起始行在视口内不裁切", () => {
    const el = document.createElement("div");
    el.style.display = "block";
    expect(
      clipShellAgentDecorationToViewport({
        viewportY: 10,
        viewportRows: 24,
        markerLine: 12,
        rows: 8,
        cellHeight: 18,
        el,
      }),
    ).toBe("full");
    expect(el.style.clipPath).toBe("");
  });

  it("clipShellAgentDecorationToViewport：顶部滚出但仍相交时负 top + clip-path", () => {
    const el = document.createElement("div");
    el.style.display = "none";
    expect(
      clipShellAgentDecorationToViewport({
        viewportY: 20,
        viewportRows: 24,
        markerLine: 16,
        rows: 12,
        cellHeight: 18,
        el,
      }),
    ).toBe("clipped");
    expect(el.style.display).toBe("block");
    expect(el.style.top).toBe("-72px");
    expect(el.style.height).toBe("216px");
    expect(el.style.clipPath).toBe("inset(72px 0 0 0)");
  });

  it("clipShellAgentDecorationToViewport：整张卡已滚出视口保持隐藏", () => {
    const el = document.createElement("div");
    el.style.display = "none";
    el.style.clipPath = "inset(10px 0 0 0)";
    expect(
      clipShellAgentDecorationToViewport({
        viewportY: 40,
        viewportRows: 24,
        markerLine: 10,
        rows: 8,
        cellHeight: 18,
        el,
      }),
    ).toBe("hidden");
    expect(el.style.display).toBe("none");
    expect(el.style.clipPath).toBe("");
  });
});
