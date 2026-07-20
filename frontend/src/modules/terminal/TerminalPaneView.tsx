import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { TerminalPane, TerminalSessionInfo, TerminalTab } from "../../stores/terminalStore";
import type { EnvironmentTag, WorkspaceResource } from "../../lib/resourceRegistry";
import { useBlocksStore } from "../../stores/blocksStore";
import { BlockContextMenu } from "../../components/terminal/BlockContextMenu";
import type { TerminalBlock } from "../../stores/blocksStore";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { showToast } from "../../stores/toastStore";
import { CommandInput, type CommandInputHandle } from "./CommandInput";
import { TerminalView } from "./TerminalView";
import { TerminalBlockFeed } from "./TerminalBlockFeed";
import { type BlueprintSource } from "./sessionBlueprints";
import {
  buildSessionMetaLine,
  parseSshSubtitle,
  resolveCommandPromptSymbol,
} from "./terminalSessionDisplay";
import { TerminalPathBreadcrumb } from "./TerminalPathBreadcrumb";
import { useTerminalSessionStats } from "./useTerminalSessionStats";
import { useTerminalUiStore } from "./terminalUiStore";
import { useTerminalRunStateStore } from "./terminalRunStateStore";
import type { TerminalInputMode } from "../../hooks/useTerminal";
import { Button } from "../../components/ui/primitives/Button";
import { hasDomTextSelection, isSimplePointerClick } from "./terminalTextSelection";
import {
  clearAllSessionBlocks,
  clearEmptyOutputBlocks,
  clearFailedShellBlocks,
  clearNoisyShellBlocks,
} from "./terminalBlockActions";

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
  /** 嵌入会话顶栏右侧（如侧栏入口），与终端信息同一行 */
  headerAccessory?: ReactNode;
  /**
   * 将会话顶栏渲染到外部容器（如 AdvanceTerminal 通栏），
   * 侧栏内容可与终端区对齐到顶栏下方。
   * `undefined`：顶栏仍在 pane 内；传入元素（含暂时为 null）则启用外置。
   */
  headerPortalHost?: HTMLElement | null;
};

const ENV_BADGE_LABELS: Record<EnvironmentTag, string> = {
  prod: "PROD",
  staging: "STG",
  dev: "DEV",
  local: "LOCAL",
  unknown: "SSH",
};

/** 展开全部：内容向下展开 */
function HeaderIconExpandAll() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 5.5L8 9.5l4-4" />
      <path d="M4 9.5L8 13.5l4-4" />
    </svg>
  );
}

/** 收起全部：内容向上收拢 */
function HeaderIconCollapseAll() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 10.5L8 6.5l4 4" />
      <path d="M4 6.5L8 2.5l4 4" />
    </svg>
  );
}

function HeaderIconClearMenu() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 4.5h10" />
      <path d="M6 4.5V3h4v1.5" />
      <path d="M12.5 4.5l-.7 8.2a1.2 1.2 0 01-1.2 1.1H5.4a1.2 1.2 0 01-1.2-1.1L3.5 4.5" />
      <path d="M6.5 7v4M9.5 7v4" />
    </svg>
  );
}

type ClearMenuItem = {
  id: string;
  label: string;
  subtitle?: string;
  danger?: boolean;
  onSelect: () => void;
};

function HeaderClearMenu({
  disabled,
  items,
  label,
}: {
  disabled: boolean;
  items: ClearMenuItem[];
  label: string;
}) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const sync = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      const minWidth = 220;
      const left = Math.min(rect.right - minWidth, window.innerWidth - minWidth - 8);
      setPos({
        top: rect.bottom + 4,
        left: Math.max(8, left),
        minWidth,
      });
    };
    const onPointerDown = (event: Event) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !wrapRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <>
      <div className="term-session-header__clear-wrap" ref={wrapRef}>
        <button
          ref={btnRef}
          type="button"
          className="term-session-header__action-btn"
          title={label}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          <HeaderIconClearMenu />
        </button>
      </div>
      {open &&
        pos &&
        createPortal(
          <div
            id={menuId}
            role="menu"
            ref={menuRef}
            className="term-session-header__clear-menu"
            style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth }}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={`term-session-header__clear-item${
                  item.danger ? " term-session-header__clear-item--danger" : ""
                }`}
                onClick={() => {
                  item.onSelect();
                  setOpen(false);
                }}
              >
                <span className="term-session-header__clear-item-label">{item.label}</span>
                {item.subtitle ? (
                  <span className="term-session-header__clear-item-sub">{item.subtitle}</span>
                ) : null}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function TerminalSessionHeader({
  paneId,
  resource,
  session,
  connected,
  inputMode,
  onToggleInputMode,
  onRunCommand,
  headerAccessory,
}: {
  paneId: string;
  resource: WorkspaceResource | null;
  session: TerminalSessionInfo;
  connected: boolean;
  inputMode: TerminalInputMode;
  onToggleInputMode: () => void;
  onRunCommand?: (command: string) => void;
  headerAccessory?: ReactNode;
}) {
  const { t } = useI18n();
  const stats = useTerminalSessionStats(session.resourceId, connected);
  const parsed = parseSshSubtitle(resource?.subtitle);
  const user = parsed.user ?? (session.type === "local" ? null : "root");
  const meta = buildSessionMetaLine(session, resource, stats);
  const hostAddress =
    parsed.host && parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;
  const expandAllShellBodies = useTerminalUiStore((s) => s.expandAllShellBodies);
  const collapseAllShellBodies = useTerminalUiStore((s) => s.collapseAllShellBodies);
  const blockCount = useBlocksStore((s) => (s.blocks[paneId] ?? []).length);

  const pathNav = (
    <TerminalPathBreadcrumb
      cwd={session.cwd}
      user={user}
      sessionType={session.type}
      onRunCommand={onRunCommand}
      variant="header"
    />
  );

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

  const handleClearEmpty = async () => {
    const ok = await appConfirm(
      t("terminal.feed.clearEmptyConfirm"),
      t("terminal.feed.clearEmpty"),
      { kind: "warning", confirmLabel: t("terminal.feed.confirmAction") },
    );
    if (!ok) return;
    const removed = clearEmptyOutputBlocks(paneId);
    showToast(
      removed > 0
        ? t("terminal.feed.clearEmptyDone", { count: removed })
        : t("terminal.feed.clearEmptyNone"),
    );
  };

  const handleClearNoisy = async () => {
    const ok = await appConfirm(
      t("terminal.feed.clearNoisyConfirm"),
      t("terminal.feed.clearNoisy"),
      { kind: "warning", confirmLabel: t("terminal.feed.confirmAction") },
    );
    if (!ok) return;
    const removed = clearNoisyShellBlocks(paneId);
    showToast(
      removed > 0
        ? t("terminal.feed.clearNoisyDone", { count: removed })
        : t("terminal.feed.clearNoisyNone"),
    );
  };

  const handleClearFailed = async () => {
    const ok = await appConfirm(
      t("terminal.feed.clearFailedConfirm"),
      t("terminal.feed.clearFailed"),
      { kind: "warning", confirmLabel: t("terminal.feed.confirmAction") },
    );
    if (!ok) return;
    const removed = clearFailedShellBlocks(paneId);
    showToast(
      removed > 0
        ? t("terminal.feed.clearFailedDone", { count: removed })
        : t("terminal.feed.clearFailedNone"),
    );
  };

  const handleClearAll = async () => {
    const ok = await appConfirm(
      t("terminal.feed.clearAllConfirm"),
      t("terminal.feed.clearAll"),
      { kind: "warning", confirmLabel: t("terminal.feed.confirmAction") },
    );
    if (!ok) return;
    clearAllSessionBlocks(paneId);
    showToast(t("terminal.feed.clearAllDone"));
  };

  const clearMenuItems: ClearMenuItem[] = [
    {
      id: "empty",
      label: t("terminal.feed.clearEmpty"),
      subtitle: t("terminal.feed.clearEmptyHint"),
      onSelect: () => void handleClearEmpty(),
    },
    {
      id: "noisy",
      label: t("terminal.feed.clearNoisy"),
      subtitle: t("terminal.feed.clearNoisyHint"),
      onSelect: () => void handleClearNoisy(),
    },
    {
      id: "failed",
      label: t("terminal.feed.clearFailed"),
      subtitle: t("terminal.feed.clearFailedHint"),
      onSelect: () => void handleClearFailed(),
    },
    {
      id: "all",
      label: t("terminal.feed.clearAll"),
      subtitle: t("terminal.feed.clearAllHint"),
      danger: true,
      onSelect: () => void handleClearAll(),
    },
  ];

  const blockActions =
    inputMode === "external" ? (
      <div className="term-session-header__actions" role="toolbar" aria-label={t("terminal.feed.actionsToolbar")}>
        <button
          type="button"
          className="term-session-header__action-btn"
          title={t("terminal.feed.expandAll")}
          aria-label={t("terminal.feed.expandAll")}
          disabled={blockCount === 0}
          onClick={() => expandAllShellBodies(paneId)}
        >
          <HeaderIconExpandAll />
        </button>
        <button
          type="button"
          className="term-session-header__action-btn"
          title={t("terminal.feed.collapseAll")}
          aria-label={t("terminal.feed.collapseAll")}
          disabled={blockCount === 0}
          onClick={() => collapseAllShellBodies(paneId)}
        >
          <HeaderIconCollapseAll />
        </button>
        <HeaderClearMenu
          disabled={blockCount === 0}
          label={t("terminal.feed.clearMenu")}
          items={clearMenuItems}
        />
      </div>
    ) : null;

  const rightMetaLine = [hostAddress, meta].filter(Boolean).join(" · ") || null;

  const headerRight = (
    <div className="term-session-header__right">
      {blockActions}
      {modeToggle}
      {rightMetaLine ? (
        <span className="term-session-meta">{rightMetaLine}</span>
      ) : null}
      {headerAccessory}
    </div>
  );


  if (session.type === "local") {
    const hostLabel = stats?.hostName?.trim() || resource?.name || "本地终端";
    return (
      <div className="term-session-header">
        <div className="term-session-header__left">
          <span className="term-session-env term-session-env--local">
            {ENV_BADGE_LABELS.local}
          </span>
          <span className="term-session-host">{hostLabel}</span>
          <span className="term-session-muted">:</span>
          {pathNav}
        </div>
        {headerRight}
      </div>
    );
  }

  if (resource?.type !== "ssh") return null;

  return (
    <div className="term-session-header">
      <div className="term-session-header__left">
        <span className={`term-session-env term-session-env--${resource.environment}`}>
          {ENV_BADGE_LABELS[resource.environment] ?? "SSH"}
        </span>
        <span className="term-session-host">
          {user ?? "root"}@{resource.name}
        </span>
        <span className="term-session-muted">:</span>
        {pathNav}
      </div>
      {headerRight}
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
    headerAccessory,
    headerPortalHost,
  }: CommonProps & { currentResourceId: string },
  ref: React.ForwardedRef<TerminalPaneViewHandle>,
) {
  const cmdRef = useRef<CommandInputHandle>(null);
  const feedPressRef = useRef<{ x: number; y: number } | null>(null);
  const [blockMenu, setBlockMenu] = useState<{
    block: TerminalBlock;
    position: { x: number; y: number };
  } | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const inputMode = useTerminalUiStore(
    (state) => state.inputModes[paneId] ?? "external",
  );
  const setInputMode = useTerminalUiStore((state) => state.setInputMode);
  const fullTerminal = useTerminalRunStateStore(
    (state) => state.getRunState(paneId) === "full-terminal",
  );
  const lastError = useBlocksStore((state) => state.getLastError(paneId));
  const parsed = parseSshSubtitle(resource?.subtitle);
  const promptSymbol = resolveCommandPromptSymbol(session, parsed.user, resource);
  const sessionUser = parsed.user ?? (session.type === "local" ? null : "root");
  const liveNative = inputMode === "external" && fullTerminal;

  useImperativeHandle(ref, () => ({
    focusInput: () => {
      cmdRef.current?.focus();
    },
  }));

  useEffect(() => {
    if (isActive && inputMode === "external" && !liveNative) {
      cmdRef.current?.focus();
    }
  }, [isActive, inputMode, liveNative]);

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

  const handleReconnect = useCallback(() => {
    setReconnectKey((value) => value + 1);
  }, []);

  const sessionHeader = (
    <TerminalSessionHeader
      paneId={paneId}
      resource={resource}
      session={session}
      connected={connected}
      inputMode={inputMode}
      onToggleInputMode={toggleInputMode}
      onRunCommand={onSendCommand}
      headerAccessory={headerAccessory}
    />
  );
  const useExternalHeader = headerPortalHost !== undefined;
  const externalHeader =
    useExternalHeader && headerPortalHost
      ? createPortal(sessionHeader, headerPortalHost)
      : null;

  return (
    <div
      className={`term-pane term-pane-leaf${isActive ? " is-active" : ""}${useExternalHeader ? " term-pane--external-header" : ""}`}
      data-pane-id={paneId}
      onMouseDown={onActivate}
    >
      {externalHeader}
      {!useExternalHeader ? sessionHeader : null}
      <div
        className={`terminal-area term-terminal-shell${inputMode === "external" ? " term-terminal-shell--warp" : ""}`}
        tabIndex={-1}
        onMouseDownCapture={(event) => {
          onActivate();
          if (liveNative) return;
          if (inputMode !== "external") return;
          const target = event.target as HTMLElement;
          if (target.closest(".term-warp-feed")) {
            feedPressRef.current = { x: event.clientX, y: event.clientY };
            return;
          }
          feedPressRef.current = null;
          event.preventDefault();
          focusCommandInput();
        }}
        onMouseUpCapture={(event) => {
          if (inputMode !== "external") return;
          const target = event.target as HTMLElement;
          if (!target.closest(".term-warp-feed")) return;

          const press = feedPressRef.current;
          feedPressRef.current = null;
          if (!press || !isSimplePointerClick(press, { x: event.clientX, y: event.clientY })) {
            return;
          }

          requestAnimationFrame(() => {
            if (hasDomTextSelection()) return;
            focusCommandInput();
          });
        }}
      >
        {inputMode === "external" && !liveNative ? (
          <TerminalBlockFeed
            sessionId={paneId}
            resourceId={session.resourceId}
            promptSymbol={promptSymbol}
            onRunCommand={onSendCommand}
            sessionType={session.type}
            sessionUser={sessionUser}
            onFocusInput={focusCommandInput}
            isActive={isActive}
          />
        ) : null}
        <TerminalView
          key={`${paneId}:${blueprintSource.type ?? "local"}:${currentResourceId}`}
          sessionId={paneId}
          resource={resource}
          startup={startup}
          active={isActive}
          inputMode={inputMode}
          liveNative={liveNative}
          onSenderChange={onSenderChange}
          onBlockRightClick={handleBlockRightClick}
          reconnectKey={reconnectKey}
        />
      </div>
      {inputMode === "external" && !liveNative ? (
        <CommandInput
          ref={cmdRef}
          promptSymbol={promptSymbol}
          onSend={onSendCommand}
          sessionId={paneId}
          cwd={session.cwd}
          resourceId={session.resourceId}
          sessionType={session.type}
          lastError={lastError}
        />
      ) : null}
      {blockMenu ? (
        <BlockContextMenu
          block={blockMenu.block}
          position={blockMenu.position}
          onClose={() => setBlockMenu(null)}
          onRunCommand={onSendCommand}
          onReconnect={handleReconnect}
          sessionId={paneId}
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
