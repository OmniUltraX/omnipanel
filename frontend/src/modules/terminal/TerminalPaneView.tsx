import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { TerminalPane, TerminalTab } from "../../stores/terminalStore";
import type { WorkspaceResource } from "../../lib/resourceRegistry";
import { CommandInput, type CommandInputHandle } from "./CommandInput";
import { TerminalView } from "./TerminalView";
import { type BlueprintSource } from "./sessionBlueprints";

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
};

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
    currentResourceId,
  }: CommonProps & { currentResourceId: string },
  ref: React.ForwardedRef<TerminalPaneViewHandle>,
) {
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

  return (
    <div
      className={`term-pane term-pane-leaf${isActive ? " is-active" : ""}`}
      data-pane-id={paneId}
      onMouseDown={onActivate}
    >
      <div className="terminal-area term-terminal-shell" tabIndex={-1}>
        <TerminalView
          key={`${paneId}:${blueprintSource.type ?? "local"}:${currentResourceId}`}
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
}

const ForwardedBody = forwardRef<TerminalPaneViewHandle, CommonProps & { currentResourceId: string }>(
  PaneViewBody,
);

export type TerminalTabPaneViewProps = Omit<CommonProps, "blueprintSource"> & {
  tab: TerminalTab;
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
