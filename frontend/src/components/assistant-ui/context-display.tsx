"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/primitives/tooltip";
import { cn } from "@/lib/utils";
import {
  createContext,
  useContext,
  useMemo,
  type FC,
  type ReactNode,
} from "react";
import { useI18n } from "../../i18n";

export type ThreadTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${tokens}`;
};

const getUsagePercent = (
  totalTokens: number | undefined,
  modelContextWindow: number,
): number => {
  if (!totalTokens || modelContextWindow <= 0) return 0;
  return Math.min((totalTokens / modelContextWindow) * 100, 100);
};

type UsageSeverity = "normal" | "warning" | "critical";

const getUsageSeverity = (percent: number): UsageSeverity => {
  if (percent > 85) return "critical";
  if (percent >= 65) return "warning";
  return "normal";
};

const getStrokeColor = (percent: number): string => {
  const severity = getUsageSeverity(percent);
  if (severity === "critical") return "stroke-red-500";
  if (severity === "warning") return "stroke-amber-500";
  return "stroke-foreground";
};

const getBarColor = (percent: number): string => {
  const severity = getUsageSeverity(percent);
  if (severity === "critical") return "bg-red-500";
  if (severity === "warning") return "bg-amber-500";
  return "bg-foreground";
};

type ContextDisplayContextValue = {
  usage: ThreadTokenUsage | undefined;
  totalTokens: number;
  percent: number;
  modelContextWindow: number;
};

const ContextDisplayContext = createContext<ContextDisplayContextValue | null>(
  null,
);

function useContextDisplay(): ContextDisplayContextValue {
  const ctx = useContext(ContextDisplayContext);
  if (!ctx) {
    throw new Error("ContextDisplay.* must be used within ContextDisplay.Root");
  }
  return ctx;
}

type PresetProps = {
  modelContextWindow: number;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  usage?: ThreadTokenUsage | undefined;
};

type ContextDisplayRootProps = {
  modelContextWindow: number;
  children: ReactNode;
  usage?: ThreadTokenUsage | undefined;
};

function ContextDisplayRoot({
  modelContextWindow,
  children,
  usage,
}: ContextDisplayRootProps) {
  const totalTokens =
    usage?.totalTokens ??
    (usage
      ? (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.cachedInputTokens ?? 0) +
        (usage.reasoningTokens ?? 0)
      : 0);
  const percent = getUsagePercent(totalTokens, modelContextWindow);

  const contextValue = useMemo(
    () => ({
      usage,
      totalTokens,
      percent,
      modelContextWindow,
    }),
    [usage, totalTokens, percent, modelContextWindow],
  );

  return (
    <ContextDisplayContext.Provider value={contextValue}>
      {children}
    </ContextDisplayContext.Provider>
  );
}

function ContextDisplayTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <TooltipTrigger asChild>
      <button
        type="button"
        className={cn(
          "aui-context-display-trigger text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </TooltipTrigger>
  );
}

type ContextSegment = {
  label: string;
  tokens: number;
};

function ContextDisplayContent({
  side = "top",
  className,
}: {
  side?: "top" | "bottom" | "left" | "right" | undefined;
  className?: string;
}) {
  const { t } = useI18n();
  const { usage, totalTokens, percent, modelContextWindow } =
    useContextDisplay();

  const segments: ContextSegment[] = [
    { label: t("ai.contextUsage.input"), tokens: usage?.inputTokens ?? 0 },
    {
      label: t("ai.contextUsage.cached"),
      tokens: usage?.cachedInputTokens ?? 0,
    },
    { label: t("ai.contextUsage.output"), tokens: usage?.outputTokens ?? 0 },
    {
      label: t("ai.contextUsage.reasoning"),
      tokens: usage?.reasoningTokens ?? 0,
    },
  ].filter((segment) => segment.tokens > 0);

  return (
    <TooltipContent
      side={side}
      className={cn(
        "aui-context-display-content bg-popover text-popover-foreground border-border z-[var(--z-subwindow-popover)] w-56 border p-3 text-left shadow-md",
        className,
      )}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-xs font-medium">
          {t("ai.contextUsage.title")}
        </span>
        <span className="font-mono text-xs tabular-nums">
          {formatTokenCount(Math.min(totalTokens, modelContextWindow))} /{" "}
          {formatTokenCount(modelContextWindow)}
        </span>
      </div>
      <div className="bg-muted mb-2 h-1.5 w-full overflow-hidden rounded-full">
        <div
          className={cn("h-full rounded-full transition-[width]", getBarColor(percent))}
          style={{ width: `${percent}%` }}
        />
      </div>
      {segments.length > 0 ? (
        <ul className="space-y-1">
          {segments.map((segment) => (
            <li
              key={segment.label}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span className="text-muted-foreground">{segment.label}</span>
              <span className="font-mono tabular-nums">
                {formatTokenCount(segment.tokens)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">
          {t("ai.contextUsage.estimatedHint")}
        </p>
      )}
      <p className="text-muted-foreground mt-2 text-[10px] tabular-nums">
        {Math.round(percent)}%
      </p>
    </TooltipContent>
  );
}

const RING_SIZE = 18;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function RingVisual() {
  const { percent } = useContextDisplay();
  const offset = RING_CIRCUMFERENCE * (1 - percent / 100);

  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className="shrink-0 -rotate-90"
      aria-hidden
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        className="stroke-muted"
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={offset}
        className={cn("transition-[stroke-dashoffset]", getStrokeColor(percent))}
      />
    </svg>
  );
}

function RingPercentLabel() {
  const { percent } = useContextDisplay();
  return (
    <span className="font-mono text-[10px] tabular-nums leading-none">
      {Math.round(percent)}%
    </span>
  );
}

const ContextDisplayRing: FC<PresetProps> = ({
  modelContextWindow,
  className,
  side = "top",
  usage,
}) => (
  <ContextDisplayRoot modelContextWindow={modelContextWindow} usage={usage}>
    <Tooltip>
      <ContextDisplayTrigger
        className={className}
        aria-label="Context usage"
      >
        <RingVisual />
        <RingPercentLabel />
      </ContextDisplayTrigger>
      <ContextDisplayContent side={side} />
    </Tooltip>
  </ContextDisplayRoot>
);

const ContextDisplay = {
  Root: ContextDisplayRoot,
  Trigger: ContextDisplayTrigger,
  Content: ContextDisplayContent,
  Ring: ContextDisplayRing,
};

export {
  ContextDisplay,
  ContextDisplayRoot,
  ContextDisplayTrigger,
  ContextDisplayContent,
  ContextDisplayRing,
};
