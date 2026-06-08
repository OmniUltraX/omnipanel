import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { TerminalPane } from "../../stores/terminalStore";
import type { WorkspaceResource } from "../../lib/resourceRegistry";
import { CommandInput, type CommandInputHandle } from "./CommandInput";
import { TerminalView } from "./TerminalView";
import { Button } from "../../components/ui/Button";
import { formatPaneHeaderTitle } from "./paneHeader";
import {
  PaneServerSelector,
  type PaneServerOption,
} from "./PaneServerSelector";

export type TerminalPaneViewHandle = {
  focusInput: () => void;
};

export type TerminalPaneViewProps = {
  paneId: string;
  resource: WorkspaceResource | null;
  pane: TerminalPane;
  isActive: boolean;
  startup?: string[];
  onActivate: () => void;
  onSendCommand: (command: string) => void;
  onSenderChange: (
    sessionId: string,
    sender: ((cmd: string) => void) | null,
  ) => void;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onClose: () => void;
  canClose: boolean;
  serverOptions?: PaneServerOption[];
  occupiedResourceIds?: Set<string>;
  onServerChange?: (resourceId: string) => void;
};

export const TerminalPaneView = forwardRef<TerminalPaneViewHandle, TerminalPaneViewProps>(
  function TerminalPaneView({
    paneId,
    resource,
    pane,
    isActive,
    startup = [],
    onActivate,
    onSendCommand,
    onSenderChange,
    onSplitHorizontal,
    onSplitVertical,
    onClose,
    canClose,
    serverOptions,
    occupiedResourceIds,
    onServerChange,
  }, ref) {
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

    const headerTitle = formatPaneHeaderTitle(resource, pane);

    const effectiveOptions = useMemo(() => {
      if (!serverOptions || !occupiedResourceIds || occupiedResourceIds.size === 0) {
        return serverOptions;
      }
      return serverOptions.filter(
        (opt) => !occupiedResourceIds.has(opt.value) || opt.value === pane.resourceId,
      );
    }, [serverOptions, occupiedResourceIds, pane.resourceId]);

    return (
      <div
        className={`term-pane term-pane-leaf${isActive ? " is-active" : ""}`}
        data-pane-id={paneId}
        onMouseDown={onActivate}
      >
        <div className="term-pane-header">
          {effectiveOptions && effectiveOptions.length > 0 && onServerChange ? (
            <PaneServerSelector
              value={pane.resourceId}
              options={effectiveOptions}
              onChange={onServerChange}
              disabled={pane.status === "connecting"}
            />
          ) : (
            <span className="term-pane-title">{headerTitle}</span>
          )}
          <div className="term-pane-actions">
            <Button
              variant="icon"
              className="term-pane-action"
              onClick={(e) => {
                e.stopPropagation();
                onSplitHorizontal();
              }}
              title="左右拆分"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                width="14"
                height="14"
              >
                <rect x="1" y="2" width="14" height="12" rx="1.5" />
                <line x1="8" y1="2" x2="8" y2="14" />
              </svg>
            </Button>
            <Button
              variant="icon"
              className="term-pane-action"
              onClick={(e) => {
                e.stopPropagation();
                onSplitVertical();
              }}
              title="上下拆分"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                width="14"
                height="14"
              >
                <rect x="1" y="2" width="14" height="12" rx="1.5" />
                <line x1="1" y1="8" x2="15" y2="8" />
              </svg>
            </Button>
            {canClose && (
              <Button
                variant="icon"
                className="term-pane-action term-pane-action--close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
                title="关闭窗格"
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  width="14"
                  height="14"
                >
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
              </Button>
            )}
          </div>
        </div>
        <div className="terminal-area term-terminal-shell" tabIndex={-1}>
          <TerminalView
            key={`${paneId}:${pane.type}:${pane.resourceId}`}
            sessionId={paneId}
            resource={resource}
            startup={startup}
            active={isActive}
            onSenderChange={onSenderChange}
          />
        </div>
        <CommandInput ref={cmdRef} onSend={onSendCommand} />
      </div>
    );
  },
);
