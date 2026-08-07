import { beforeEach, describe, expect, it } from "vitest";
import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { registerXterm, unregisterXterm } from "../xtermRegistry";
import {
  archiveActiveInlineCard,
  beginShellAgentCard,
  cardRowsFor,
  clearShellAgentGeometry,
  disposeShellAgentCard,
  getShellAgentGeometry,
  minCardRowsFor,
  resizeShellAgentCard,
} from "./shellAgentGeometry";

type FakeTerm = {
  cols: number;
  writes: string[];
  markers: FakeMarker[];
  decorations: FakeDecoration[];
  registerMarker: (offset: number) => IMarker;
  registerDecoration: (opts: { marker: IMarker; height?: number }) => IDecoration | undefined;
  write: (data: string, cb?: () => void) => void;
  failDecoration: boolean;
};

type FakeMarker = {
  isDisposed: boolean;
  disposedCount: number;
  dispose: () => void;
};

type FakeDecoration = {
  marker: IMarker;
  height?: number;
  disposed: boolean;
};

function createFakeTerm(): FakeTerm {
  const term: FakeTerm = {
    cols: 80,
    writes: [],
    markers: [],
    decorations: [],
    failDecoration: false,
    registerMarker() {
      const marker: FakeMarker = {
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
        element: undefined,
        onRender: () => ({ dispose: () => {} }),
        dispose: () => {
          deco.disposed = true;
        },
      } as unknown as IDecoration;
    },
    write(data, cb) {
      term.writes.push(data);
      cb?.();
    },
  };
  return term;
}

const SID = "test-geo-session";

describe("shellAgentGeometry", () => {
  beforeEach(() => {
    clearShellAgentGeometry(SID);
    unregisterXterm(SID);
  });

  it("minCardRowsFor：各类型统一最小 1 行起步", () => {
    expect(minCardRowsFor("thinking")).toBe(1);
    expect(minCardRowsFor("cmd")).toBe(1);
    expect(minCardRowsFor("final")).toBe(1);
    expect(cardRowsFor("cmd")).toBe(1);
  });

  it("beginShellAgentCard：最小占位行 + marker+decoration 就位", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);

    const geo = beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "查一下磁盘",
    });

    expect(geo.mode).toBe("inline");
    expect(geo.rows).toBe(1);
    expect(term.writes.join("")).toBe("\r\n");
    expect(term.markers).toHaveLength(1);
    expect(term.decorations).toHaveLength(1);
    expect(term.decorations[0].height).toBe(1);
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
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q",
    });

    resizeShellAgentCard(SID, 6);
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });

    const geo = getShellAgentGeometry(SID);
    expect(geo?.rows).toBe(6);
    // 1（初次） + 5（扩）
    expect(term.writes.join("")).toBe("\r\n".repeat(6));
    expect(term.decorations).toHaveLength(2);
    expect(term.decorations[1].height).toBe(6);
    // marker 复用不重建
    expect(term.markers).toHaveLength(1);
  });

  it("disposeShellAgentCard：撤卡留占位，几何归零", () => {
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
    expect(geo?.mode).toBe("detached");
    expect(geo?.cardKind).toBeNull();
    expect(geo?.decoration).toBeNull();
    expect(geo?.rows).toBe(0);
    expect(term.decorations[0].disposed).toBe(true);
  });

  it("archiveActiveInlineCard：归档后 detached，decoration 不 dispose", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "q",
    });

    archiveActiveInlineCard(SID);

    const geo = getShellAgentGeometry(SID);
    expect(geo?.mode).toBe("detached");
    expect(term.decorations[0].disposed).toBe(false);
  });
});
