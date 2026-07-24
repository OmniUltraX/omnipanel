import { useEffect, useRef, useState } from "react";
import type {
  IBufferLine,
  ILink,
  ILinkProvider,
  Terminal,
} from "@xterm/xterm";
import { detectFilePathRanges, resolveDetectedFilePath } from "./terminalFileLinks";
import {
  resolvePreviewConnectionId,
  tryOpenTerminalFilePreview,
} from "./terminalFilePreviewStore";

export interface UseTerminalFileLinkProviderParams {
  /** 共享 term ref——useTerminal 内部异步创建 term 后写入此 ref */
  termRef: React.RefObject<Terminal | null>;
  /** 当前 terminal pane id */
  paneId: string;
  sessionType: "local" | "remote";
  remoteHome: string | null;
  resourceId: string | null;
  cwd: string;
  enabled: boolean;
}

interface LinkContext {
  sessionType: "local" | "remote";
  resourceId: string | null;
  remoteHome: string | null;
  cwd: string;
}

/** 注册一个 xterm ILinkProvider：识别终端输出中的文件路径，点击时打开预览。
 *
 *  设计要点：
 *  - 不订阅 zustand（避免与 useTerminal 内部 zustand 订阅互相触发 re-render）
 *  - term 实例从 termRef 拿；useTerminal 在 initTerminal 完成后会写入 termRef
 *  - link provider 只在 term 第一次就绪时注册一次
 *  - ctxRef 内部更新 useEffect 依赖 cwd/resourceId/...：当 terminal 关联的 session
 *    信息变化时，激活回调拿到的就是最新 context（不需要重新注册 provider）
 */
export function useTerminalFileLinkProvider({
  termRef,
  paneId,
  sessionType,
  remoteHome,
  resourceId,
  cwd,
  enabled,
}: UseTerminalFileLinkProviderParams): void {
  const [term, setTerm] = useState<Terminal | null>(null);
  // 单次轮询 termRef 直到拿到 term（不订阅 zustand，不订阅 term 自身 state）
  useEffect(() => {
    if (!enabled) return;
    if (term) return;
    let cancelled = false;
    let attempts = 0;
    const tick = () => {
      if (cancelled) return;
      const t = termRef.current;
      if (t) {
        setTerm(t);
        return;
      }
      if (++attempts > 200) return; // 10s timeout
      setTimeout(tick, 50);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [term, termRef, enabled]);

  // ctxRef 内部更新 useEffect（避免 render 期副作用触发 re-render）
  const ctxRef = useRef<LinkContext>({
    sessionType,
    resourceId,
    remoteHome,
    cwd,
  });
  useEffect(() => {
    ctxRef.current = { sessionType, resourceId, remoteHome, cwd };
  }, [sessionType, resourceId, remoteHome, cwd]);

  // 注册 link provider；只在 term 第一次就绪时跑一次
  useEffect(() => {
    if (!term || !enabled) return;
    const provider: ILinkProvider = {
      provideLinks(
        bufferLineNumber: number,
        callback: (links: ILink[] | undefined) => void,
      ): void {
        const buffer = term.buffer.active;
        const line = buffer.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = lineToText(line);
        const ranges = detectFilePathRanges(text);
        if (ranges.length === 0) {
          callback(undefined);
          return;
        }
        const links = buildLinks(ranges, ctxRef.current);
        callback(links);
      },
    };
    const handle = term.registerLinkProvider(provider);
    return () => {
      handle.dispose();
    };
  }, [term, enabled]);

  void paneId;
}

function lineToText(line: IBufferLine): string {
  return line.translateToString(true);
}

function buildLinks(
  ranges: Array<{ text: string; start: number; end: number }>,
  ctx: LinkContext,
): ILink[] | undefined {
  const out: ILink[] = [];
  for (const r of ranges) {
    const resolved = resolveDetectedFilePath({
      text: r.text,
      cwd: ctx.cwd || "/",
      sessionType: ctx.sessionType,
      remoteHome: ctx.remoteHome,
    });
    if (!resolved) continue;
    if (resolved.absolutePath.endsWith("/")) continue;
    out.push({
      range: {
        start: { x: r.start + 1, y: 1 },
        end: { x: r.end + 1, y: 1 },
      },
      text: r.text,
      activate: (_event, _text) => {
        const connectionId = resolvePreviewConnectionId(
          ctx.sessionType,
          ctx.resourceId,
        );
        tryOpenTerminalFilePreview({
          connectionId,
          absolutePath: resolved.absolutePath,
          name: resolved.name,
          resourceId: ctx.resourceId,
          sessionType: ctx.sessionType,
        });
      },
    });
  }
  return out.length > 0 ? out : undefined;
}
