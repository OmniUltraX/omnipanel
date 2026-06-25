import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { TerminalPane, TerminalSessionInfo, TerminalTab } from "../../stores/terminalStore";
import type { EnvironmentTag, WorkspaceResource } from "../../lib/resourceRegistry";
import { useBlocksStore } from "../../stores/blocksStore";
import { BlockContextMenu } from "../../components/terminal/BlockContextMenu";
import type { TerminalBlock } from "../../stores/blocksStore";
import { useI18n } from "../../i18n";
import { CommandInput, type CommandInputHandle } from "./CommandInput";
import { TerminalView } from "./TerminalView";
import { TerminalBlockFeed } from "./TerminalBlockFeed";
import { type BlueprintSource } from "./sessionBlueprints";
import {
  buildSessionMetaLine,
  formatTerminalCwdDisplay,
  parseSshSubtitle,
  resolveCommandPromptSymbol,
} from "./terminalSessionDisplay";
import { useTerminalSessionStats } from "./useTerminalSessionStats";
import { useTerminalUiStore } from "./terminalUiStore";
import type { TerminalInputMode } from "../../hooks/useTerminal";
import { Button } from "../../components/ui/Button";

export type TerminalPaneViewHandle = {
  focusInput: () => void;
};

type CommonProps = {
  paneId: string;
  session: TerminalSessionInfo;
  resource: WorkspaceResource | null;
  blueprintSource: BlueprintSource;
  isActive: boolean;
  connected: boolean;
  startup?: string[];
  onActivate: () => void;
  onSendCommand: (command: string) => void;
  onSenderChange: (
    sessionId: string,
    sender: ((cmd: string) => void) | null,
  ) => void;
};

const ENV_BADGE_LABELS: Record<EnvironmentTag, string> = {
  prod: "PROD",
  staging: "STG",
  dev: "DEV",
  local: "LOCAL",
  unknown: "SSH",
};

function TerminalSessionHeader({
  resource,
  session,
  connected,
  inputMode,
  onToggleInputMode,
}: {
  resource: WorkspaceResource | null;
  session: TerminalSessionInfo;
  connected: boolean;
  inputMode: TerminalInputMode;
  onToggleInputMode: () => void;
}) {
  const { t } = useI18n();
  const stats = useTerminalSessionStats(session.resourceId, connected);
  const parsed = parseSshSubtitle(resource?.subtitle);
  const user = parsed.user ?? (session.type === "local" ? null : "root");
  const path = formatTerminalCwdDisplay(session.cwd, user);
  const meta = buildSessionMetaLine(session, resource, stats);
  const hostAddress =
    parsed.host && parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;

  const modeToggle = (
    <Button
      variant="ghost"
      size="xs"
      className="term-input-mode-toggle"
      onClick={onToggleInputMode}
      title={
        inputMode === "external"
          ? t("terminal.inputMode.switchToNative")
          : t("terminal.inputMode.switchToCommandBar")
      }
      type="button"
    >
      {inputMode === "external" ? t("terminal.inputMode.commandBar") : t("terminal.inputMode.native")}
    </Button>
  );

  if (session.type === "local") {
    const hostLabel = stats?.hostName?.trim() || resource?.name || "本地终端";
    return (
      <div className="term-session-header">
        <span className="term-session-env term-session-env--local">
          {ENV_BADGE_LABELS.local}
        </span>
        <span className="term-session-host">{hostLabel}</span>
        <span className="term-session-muted">:</span>
        <span className="term-session-path">{path}</span>
        <span className="term-session-spacer" />
        {modeToggle}
        {meta ? <span className="term-session-meta">{meta}</span> : null}
      </div>
    );
  }

  if (resource?.type !== "ssh") return null;

  return (
    <div className="term-session-header">
      <span className={`term-session-env term-session-env--${resource.environment}`}>
        {ENV_BADGE_LABELS[resource.environment] ?? "SSH"}
      </span>
      <span className="term-session-host">
        {user ?? "root"}@{resource.name}
      </span>
      <span className="term-session-muted">:</span>
      <span className="term-session-path">{path}</span>
      {hostAddress ? (
        <span className="term-session-muted">· {hostAddress}</span>
      ) : null}
      <span className="term-session-spacer" />
      {modeToggle}
      {meta ? <span className="term-session-meta">{meta}</span> : null}
    </div>
  );
}

function PaneViewBody(
  {
    paneId,
    session,
    resource,
    blueprintSource,
    isActive,
    connected,
    startup = [],
    onActivate,
    onSendCommand,
    onSenderChange,
    currentResourceId,
  }: CommonProps & { currentResourceId: string },
  ref: React.ForwardedRef<TerminalPaneViewHandle>,
) {
  const cmdRef = useRef<CommandInputHandle>(null);
  const [blockMenu, setBlockMenu] = useState<{
    block: TerminalBlock;
    position: { x: number; y: number };
  } | null>(null);
  const inputMode = useTerminalUiStore(
    (state) => state.inputModes[paneId] ?? "external",
  );
  const setInputMode = useTerminalUiStore((state) => state.setInputMode);
  const lastError = useBlocksStore((state) => state.getLastError(paneId));
  const parsed = parseSshSubtitle(resource?.subtitle);
  const promptSymbol = resolveCommandPromptSymbol(session, parsed.user, resource);

  useImperativeHandle(ref, () => ({
    focusInput: () => {
      cmdRef.current?.focus();
    },
  }));

  useEffect(() => {
    if (isActive && inputMode === "external") {
      cmdRef.current?.focus();
    }
  }, [isActive, inputMode]);

  const focusCommandInput = () => {
    if (inputMode !== "external") return;
    requestAnimationFrame(() => {
      cmdRef.current?.focus();
    });
  };

  const handleBlockRightClick = useCallback(
    (block: TerminalBlock, position: { x: number; y: number }) => {
      setBlockMenu({ block, position });
    },
    [],
  );

  const toggleInputMode = useCallback(() => {
    setInputMode(paneId, inputMode === "external" ? "interactive" : "external");
  }, [inputMode, paneId, setInputMode]);

  return (
    <div
      className={`term-pane term-pane-leaf${isActive ? " is-active" : ""}`}
      data-pane-id={paneId}
      onMouseDown={onActivate}
    >
      <TerminalSessionHeader
        resource={resource}
        session={session}
        connected={connected}
        inputMode={inputMode}
        onToggleInputMode={toggleInputMode}
      />
      <div
        className={`terminal-area term-terminal-shell${inputMode === "external" ? " term-terminal-shell--warp" : ""}`}
        tabIndex={-1}
        onMouseDownCapture={(event) => {
          onActivate();
          if (inputMode === "external") {
            event.preventDefault();
            focusCommandInput();
          }
        }}
        onClick={() => {
          if (inputMode === "external") {
            focusCommandInput();
          }
        }}
      >
        {inputMode === "external" ? (
          <TerminalBlockFeed sessionId={paneId} promptSymbol={promptSymbol} />
        ) : null}
        <TerminalView
          key={`${paneId}:${blueprintSource.type ?? "local"}:${currentResourceId}`}
          sessionId={paneId}
          resource={resource}
          startup={startup}
          active={isActive}
          inputMode={inputMode}
          onSenderChange={onSenderChange}
          onBlockRightClick={handleBlockRightClick}
        />
      </div>
      {inputMode === "external" ? (
        <CommandInput
          ref={cmdRef}
          promptSymbol={promptSymbol}
          onSend={onSendCommand}
          sessionId={paneId}
          cwd={session.cwd}
          resourceId={session.resourceId}
          sessionType={session.type}
          lastError={lastError}
          onRequestNativeMode={() =>
            setInputMode(paneId, "interactive", { autoReturn: true })
          }
        />
      ) : null}
      {blockMenu ? (
        <BlockContextMenu
          block={blockMenu.block}
          position={blockMenu.position}
          onClose={() => setBlockMenu(null)}
          onRunCommand={onSendCommand}
        />
      ) : null}
    </div>
  );
}

const ForwardedBody = forwardRef<
  TerminalPaneViewHandle,
  CommonProps & { currentResourceId: string }
>(PaneViewBody);

export type TerminalTabPaneViewProps = Omit<
  CommonProps,
  "blueprintSource" | "session" | "connected"
> & {
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
        session={tab.session}
        resource={resource}
        connected={tab.status === "connected"}
        blueprintSource={tab.session}
        currentResourceId={tab.session.resourceId}
      />
    );
  },
);

export type TerminalPaneViewProps = Omit<
  CommonProps,
  "blueprintSource" | "currentResourceId" | "session" | "connected"
> & {
  pane: TerminalPane;
};

/** SSH 内嵌多 Pane 视图（保持向后兼容） */
export const TerminalPaneView = forwardRef<TerminalPaneViewHandle, TerminalPaneViewProps>(
  function TerminalPaneView(props, ref) {
    const { pane, resource, ...rest } = props;
    const session: TerminalSessionInfo = {
      type: pane.type,
      resourceId: pane.resourceId,
      shellLabel: pane.shellLabel,
      cwd: pane.cwd,
      purpose: pane.purpose,
      commandPack: pane.commandPack,
    };
    return (
      <ForwardedBody
        ref={ref}
        {...rest}
        session={session}
        resource={resource}
        connected={pane.status === "connected"}
        blueprintSource={pane}
        currentResourceId={pane.resourceId}
      />
    );
  },
);
