import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { TerminalPane, TerminalTab } from "../../stores/terminalStore";
import type { WorkspaceResource } from "../../lib/resourceRegistry";
import { CommandInput, type CommandInputHandle } from "./CommandInput";
import { TerminalView } from "./TerminalView";
import {
  PaneServerSelector,
  type PaneServerOption,
} from "./PaneServerSelector";
import { type BlueprintSource } from "./sessionBlueprints";
import { formatPaneHeaderTitle } from "./paneHeader";
import { useI18n } from "../../i18n";

export type TerminalPaneViewHandle = {
  focusInput: () => void;
};

type CommonProps = {
  paneId: string;
  resource: WorkspaceResource | null;
  blueprintSource: BlueprintSource;
  isActive: boolean;
  startup?: string[];
  onActivate: () => void;
  onSendCommand: (command: string) => void;
  onSenderChange: (
    sessionId: string,
    sender: ((cmd: string) => void) | null,
  ) => void;
  serverOptions?: PaneServerOption[];
  occupiedResourceIds?: Set<string>;
  onServerChange?: (resourceId: string) => void;
  /** 重新连接：父组件 dispose 后端会话 + 触发 TerminalView 重建。 */
  onReconnect?: () => void;
  /** 强制重建 TerminalView 的计数器（自增即生效）。 */
  reconnectKey?: number;
  /** 正在执行用户发起的重新连接：覆盖层显示加载动画。 */
  isReconnecting?: boolean;
};

function ReconnectIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="13"
      height="13"
      aria-hidden
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" />
      <polyline points="13.5 2 13.5 5 10.5 5" />
    </svg>
  );
}

function PaneViewBody(
  {
    paneId,
    resource,
    blueprintSource,
    isActive,
    startup = [],
    onActivate,
    onSendCommand,
    onSenderChange,
    serverOptions,
    occupiedResourceIds,
    onServerChange,
    onReconnect,
    reconnectKey,
    isReconnecting,
    currentResourceId,
  }: CommonProps & { currentResourceId: string },
  ref: React.ForwardedRef<TerminalPaneViewHandle>,
) {
  const { t } = useI18n();
  const cmdRef = useRef<CommandInputHandle>(null);

  useImperativeHandle(ref, () => ({
    focusInput: () => {
      cmdRef.current?.focus();
    },
  }));

  useEffect(() => {
    if (isActive) {
      cmdRef.current?.focus();
    }
  }, [isActive]);

  const headerTitle = formatPaneHeaderTitle(resource, { title: resource?.name ?? "" });

  const effectiveOptions = useMemo(() => {
    if (!serverOptions || !occupiedResourceIds || occupiedResourceIds.size === 0) {
      return serverOptions;
    }
    return serverOptions.filter(
      (opt) => !occupiedResourceIds.has(opt.value) || opt.value === currentResourceId,
    );
  }, [serverOptions, occupiedResourceIds, currentResourceId]);

  return (
    <div
      className={`term-pane term-pane-leaf${isActive ? " is-active" : ""}`}
      data-pane-id={paneId}
      onMouseDown={onActivate}
    >
      <div className="term-pane-header">
        {effectiveOptions && effectiveOptions.length > 0 && onServerChange ? (
          <PaneServerSelector
            value={currentResourceId}
            options={effectiveOptions}
            onChange={onServerChange}
            disabled={false}
          />
        ) : (
          <span className="term-pane-title">{headerTitle}</span>
        )}
        <button
          type="button"
          className={`term-pane-reconnect drag-ignore${isReconnecting ? " is-loading" : ""}`}
          onClick={(e) => {
            // 阻止事件冒泡到 .term-pane 的 onMouseDown，避免抢占 focus
            e.stopPropagation();
            e.preventDefault();
            onReconnect?.();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          title={t("terminal.reconnect.tooltip")}
          aria-label={t("terminal.reconnect.tooltip")}
          disabled={!onReconnect || isReconnecting}
        >
          <ReconnectIcon />
        </button>
      </div>
      <div className="terminal-area term-terminal-shell" tabIndex={-1}>
        <TerminalView
          key={`${paneId}:${blueprintSource.type ?? "local"}:${currentResourceId}:${reconnectKey ?? 0}`}
          sessionId={paneId}
          resource={resource}
          startup={startup}
          active={isActive}
          onSenderChange={onSenderChange}
          reconnectKey={reconnectKey}
        />
        {isReconnecting && (
          <div className="term-pane-loading" role="status" aria-live="polite">
            <div className="term-pane-loading__inner">
              <div className="term-pane-loading__spinner" aria-hidden />
              <span className="term-pane-loading__text">
                {t("terminal.reconnect.loading")}
              </span>
            </div>
          </div>
        )}
      </div>
      <CommandInput ref={cmdRef} onSend={onSendCommand} />
    </div>
  );
}

const ForwardedBody = forwardRef<TerminalPaneViewHandle, CommonProps & { currentResourceId: string }>(
  PaneViewBody,
);

export type TerminalTabPaneViewProps = Omit<CommonProps, "blueprintSource"> & {
  tab: TerminalTab;
  onTabResourceChange?: (resourceId: string) => void;
};

/** 顶层终端 Tab 的 PaneView（单会话） */
export const TerminalTabPaneView = forwardRef<TerminalPaneViewHandle, TerminalTabPaneViewProps>(
  function TerminalTabPaneView(props, ref) {
    const { tab, resource, ...rest } = props;
    return (
      <ForwardedBody
        ref={ref}
        {...rest}
        resource={resource}
        blueprintSource={tab.session}
        currentResourceId={tab.session.resourceId}
      />
    );
  },
);

export type TerminalPaneViewProps = Omit<CommonProps, "blueprintSource" | "currentResourceId"> & {
  pane: TerminalPane;
  onServerChange?: (resourceId: string) => void;
};

/** SSH 内嵌多 Pane 视图（保持向后兼容） */
export const TerminalPaneView = forwardRef<TerminalPaneViewHandle, TerminalPaneViewProps>(
  function TerminalPaneView(props, ref) {
    const { pane, resource, ...rest } = props;
    return (
      <ForwardedBody
        ref={ref}
        {...rest}
        resource={resource}
        blueprintSource={pane}
        currentResourceId={pane.resourceId}
      />
    );
  },
);
