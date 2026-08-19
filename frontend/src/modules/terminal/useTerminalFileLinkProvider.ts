import { useCallback, useEffect, useRef, useState } from "react";
import type {
  IBufferLine,
  ILink,
  ILinkProvider,
  Terminal,
} from "@xterm/xterm";
import {
  buildPathLinkRange,
  classifyLinePathLinks,
  isTypicalDirectoryColor,
  type ClassifiedPathLink,
} from "./terminalFileLinks";
import { activateClassifiedPathLink } from "./terminalPathLinkAction";
import { isXtermMouseTrackingOn } from "./terminalFileLinks";
import { getCwdPathListing, usePrefetchCwdPathListing, prefetchCwdPathListing } from "./cwdPathListing";
import {
  classifiedPathLinkAtPointer,
  shouldHandlePathLinkPointer,
} from "./pathLinkPointer";

export interface UseTerminalFileLinkProviderParams {
  termRef: React.RefObject<Terminal | null>;
  paneId: string;
  sessionType: "local" | "remote";
  remoteHome: string | null;
  resourceId: string | null;
  cwd: string;
  enabled: boolean;
  sendCommand?: (cmd: string) => void;
  canSendCd?: () => boolean;
}

interface LinkContext {
  sessionId: string;
  sessionType: "local" | "remote";
  resourceId: string | null;
  remoteHome: string | null;
  cwd: string;
}

const CLICK_SLOP_PX = 6;

/**
 * 直连 xterm：ILinkProvider 只负责 hover 下划线。
 * 点击不走 Linkifier（关预览后 _currentLink 丢失就点不了），
 * 改为 pointerup 直接命中 buffer 格子再分流 cd / 预览。
 */
export function useTerminalFileLinkProvider({
  termRef,
  paneId,
  sessionType,
  remoteHome,
  resourceId,
  cwd,
  enabled,
  sendCommand,
  canSendCd,
}: UseTerminalFileLinkProviderParams): void {
  const [term, setTerm] = useState<Terminal | null>(null);
  const downRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  usePrefetchCwdPathListing({ enabled, sessionType, resourceId, cwd });

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
      if (++attempts > 200) return;
      setTimeout(tick, 50);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [term, termRef, enabled]);

  const ctxRef = useRef<LinkContext>({
    sessionId: paneId,
    sessionType,
    resourceId,
    remoteHome,
    cwd,
  });
  useEffect(() => {
    ctxRef.current = { sessionId: paneId, sessionType, resourceId, remoteHome, cwd };
  }, [paneId, sessionType, resourceId, remoteHome, cwd]);

  const sendCommandRef = useRef(sendCommand);
  sendCommandRef.current = sendCommand;
  const canSendCdRef = useRef(canSendCd);
  canSendCdRef.current = canSendCd;

  const provideForLine = useCallback(
    (bufferLineNumber: number, line: IBufferLine, text: string): ILink[] | undefined => {
      if (isXtermMouseTrackingOn(term)) return undefined;
      const ctx = ctxRef.current;
      const listing = getCwdPathListing(ctx.sessionType, ctx.resourceId, ctx.cwd);
      const classified = classifyLinePathLinks({
        line: text,
        cwd: ctx.cwd || "/",
        sessionType: ctx.sessionType,
        remoteHome: ctx.remoteHome,
        listing,
        isDirectoryColor: (start, end) => lineSpanIsDirectoryColor(line, start, end),
      });
      if (classified.length === 0) return undefined;
      return classified.map((item) => toHoverOnlyLink(item, bufferLineNumber));
    },
    [term],
  );

  useEffect(() => {
    if (!term || !enabled) return;
    const provider: ILinkProvider = {
      provideLinks(bufferLineNumber, callback) {
        if (isXtermMouseTrackingOn(term)) {
          callback(undefined);
          return;
        }
        const buffer = term.buffer.active;
        const line = buffer.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        callback(provideForLine(bufferLineNumber, line, line.translateToString(true)));
      },
    };
    const handle = term.registerLinkProvider(provider);
    return () => {
      handle.dispose();
    };
  }, [term, enabled, provideForLine]);

  useEffect(() => {
    if (!term || !enabled) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!shouldHandlePathLinkPointer(term, event)) {
        downRef.current = null;
        return;
      }
      downRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      const down = downRef.current;
      downRef.current = null;
      if (!down || down.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_SLOP_PX) return;
      if (!shouldHandlePathLinkPointer(term, event)) return;
      const ctx = ctxRef.current;
      const clientX = event.clientX;
      const clientY = event.clientY;
      const tryActivate = (item: ReturnType<typeof classifiedPathLinkAtPointer>) => {
        if (!item) return false;
        event.preventDefault();
        event.stopPropagation();
        activateClassifiedPathLink({
          kind: item.kind,
          absolutePath: item.absolutePath,
          name: item.name,
          sessionType: ctx.sessionType,
          resourceId: ctx.resourceId,
          canSendCd: canSendCdRef.current?.() ?? false,
          sendCommand: sendCommandRef.current,
          sessionId: ctx.sessionId,
        });
        return true;
      };
      const hit = classifiedPathLinkAtPointer({
        term,
        clientX,
        clientY,
        cwd: ctx.cwd,
        sessionType: ctx.sessionType,
        remoteHome: ctx.remoteHome,
        resourceId: ctx.resourceId,
      });
      if (tryActivate(hit)) return;
      void prefetchCwdPathListing(ctx.sessionType, ctx.resourceId, ctx.cwd).then(() => {
        const retry = classifiedPathLinkAtPointer({
          term,
          clientX,
          clientY,
          cwd: ctx.cwd,
          sessionType: ctx.sessionType,
          remoteHome: ctx.remoteHome,
          resourceId: ctx.resourceId,
        });
        tryActivate(retry);
      });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
    };
  }, [term, enabled]);
}

function lineSpanIsDirectoryColor(line: IBufferLine, start: number, end: number): boolean {
  let total = 0;
  let dirish = 0;
  const last = Math.min(end, line.length);
  for (let x = start; x < last; x += 1) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    total += 1;
    if (isTypicalDirectoryColor(cell.getFgColor(), cell.isFgPalette())) dirish += 1;
  }
  return total > 0 && dirish === total;
}

function toHoverOnlyLink(item: ClassifiedPathLink, bufferLineNumber: number): ILink {
  return {
    range: buildPathLinkRange(item.start, item.end, bufferLineNumber),
    text: item.text,
    activate: () => {
      /* 点击由 pointerup 处理，避免依赖 Linkifier hover 状态 */
    },
  };
}
