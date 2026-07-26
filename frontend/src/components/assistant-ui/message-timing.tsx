"use client";

import { useMessageTiming } from "@assistant-ui/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/primitives/tooltip";
import { cn } from "@/lib/utils";
import type { FC } from "react";
import { useI18n } from "../../i18n";

const formatTimingMs = (ms: number | undefined): string => {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

/**
 * 流式性能徽章（TTFT / 总耗时 / tok/s），依赖 message.metadata.timing。
 */
export const MessageTiming: FC<{
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
}> = ({ className, side = "right" }) => {
  const { t } = useI18n();
  const timing = useMessageTiming();
  if (timing?.totalStreamTime === undefined) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "aui-message-timing text-muted-foreground hover:text-foreground inline-flex h-6 items-center rounded-md px-1.5 font-mono text-[11px] tabular-nums transition-colors",
            className,
          )}
        >
          {formatTimingMs(timing.totalStreamTime)}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className="aui-message-timing-content bg-popover text-popover-foreground border-border z-[var(--z-subwindow-popover)] w-44 border p-2.5 text-left shadow-md"
      >
        <ul className="space-y-1 text-xs">
          {timing.firstTokenTime !== undefined && (
            <li className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                {t("ai.timing.firstToken")}
              </span>
              <span className="font-mono tabular-nums">
                {formatTimingMs(timing.firstTokenTime)}
              </span>
            </li>
          )}
          <li className="flex justify-between gap-3">
            <span className="text-muted-foreground">{t("ai.timing.total")}</span>
            <span className="font-mono tabular-nums">
              {formatTimingMs(timing.totalStreamTime)}
            </span>
          </li>
          {timing.tokensPerSecond !== undefined && (
            <li className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t("ai.timing.speed")}</span>
              <span className="font-mono tabular-nums">
                {timing.tokensPerSecond.toFixed(1)} tok/s
              </span>
            </li>
          )}
          <li className="flex justify-between gap-3">
            <span className="text-muted-foreground">{t("ai.timing.chunks")}</span>
            <span className="font-mono tabular-nums">{timing.totalChunks}</span>
          </li>
        </ul>
      </TooltipContent>
    </Tooltip>
  );
};
