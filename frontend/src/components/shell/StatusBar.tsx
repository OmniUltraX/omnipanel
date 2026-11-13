import { useEffect, useState, useCallback, type KeyboardEvent, type MouseEvent } from "react";
import { useLocation } from "react-router-dom";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorkspaceWindowStore } from "../../stores/workspaceWindowStore";
import { useBottomPanelStore, useEmbeddedWorkspaceMode } from "../../stores/bottomPanelStore";
import { getResourceById } from "../../lib/resourceRegistry";
import { isWorkspacePath } from "../../lib/paths";
import { pathnameToModuleKey } from "../../lib/moduleStatusLog";
import { useStatusBarLogStore } from "../../stores/statusBarLogStore";
import {
  useBackgroundTaskStore,
  backgroundTaskStatusBarLevel,
  countRunningBackgroundTasks,
  formatBackgroundTaskStatusMessage,
  getPrimaryBackgroundTaskForStatusBar,
  isBackgroundTaskBusy,
} from "../../stores/backgroundTaskStore";
import { useI18n } from "../../i18n";
import { ConnectionPoolIndicator } from "./ConnectionPoolIndicator";
import { BackgroundTasksWindow } from "./BackgroundTasksWindow";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { StatusBarServicesIndicator } from "./StatusBarServicesIndicator";
import { StatusBarActionBar } from "./StatusBarActionBar";
import { StatusBarInfoBar } from "./StatusBarInfoBar";
import { useActionDraftStore } from "../../stores/actionDraftStore";
import { useSpaceConflictStore } from "../../stores/spaceConflictStore";
import { WorkbenchActionButton } from "../ui/primitives/WorkbenchActionButton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/primitives/dialog";

/** 统一审批队列：状态栏待确认入口 */
function StatusBarApprovalBadge() {
  const { t } = useI18n();
  const count = useActionDraftStore((s) => s.drafts.length);
  const setGlobalDialogOpen = useActionDraftStore((s) => s.setGlobalDialogOpen);

  const handleOpen = useCallback(() => {
    setGlobalDialogOpen(true);
  }, [setGlobalDialogOpen]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleOpen();
      }
    },
    [handleOpen],
  );

  if (count <= 0) return null;

  const message = t("ai.approval.pendingCount", { count });

  return (
    <button
      type="button"
      className="statusbar-chip statusbar-chip--warn"
      title={message}
      aria-label={message}
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
    >
      <span className="statusbar-chip__pulse statusbar-chip__pulse--warn" aria-hidden />
      <span className="statusbar-chip__label">{message}</span>
    </button>
  );
}

/** 有同步冲突时才出现，点开和用户中心同一张总览。 */
function StatusBarConflictBadge() {
  const { t } = useI18n();
  const count = useSpaceConflictStore((s) => s.items.length);
  const openOverview = useSpaceConflictStore((s) => s.openOverview);

  if (count <= 0) return null;

  const message = t("app.conflict.badge", { count });

  return (
    <button
      type="button"
      className="statusbar-chip statusbar-chip--danger"
      title={t("app.conflict.hint")}
      aria-label={message}
      onClick={openOverview}
    >
      <span className="statusbar-chip__pulse statusbar-chip__pulse--danger" aria-hidden />
      <span className="statusbar-chip__label">{message}</span>
    </button>
  );
}

const COMPLETED_TASK_FLASH_MS = 4000;

/** 全局后台任务进度（切换模块后仍展示）；已完成只短暂闪一下，避免底栏常驻绿字。 */
function StatusBarBackgroundTaskLog() {
  const { t } = useI18n();
  const setTaskListOpen = useBackgroundTaskStore((s) => s.setTaskListOpen);
  const tasks = useBackgroundTaskStore((s) => s.tasks);
  const primary = getPrimaryBackgroundTaskForStatusBar(tasks);
  const runningCount = countRunningBackgroundTasks(tasks);
  const [showSettled, setShowSettled] = useState(true);

  useEffect(() => {
    if (!primary || isBackgroundTaskBusy(primary.status)) {
      setShowSettled(true);
      return;
    }
    setShowSettled(true);
    const timer = window.setTimeout(() => setShowSettled(false), COMPLETED_TASK_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [primary?.id, primary?.status, primary?.finishedAt]);

  const handleOpenTasks = useCallback(() => {
    setTaskListOpen(true);
  }, [setTaskListOpen]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleOpenTasks();
      }
    },
    [handleOpenTasks],
  );

  if (!primary) {
    return null;
  }
  if (!isBackgroundTaskBusy(primary.status) && !showSettled) {
    return null;
  }

  const message = formatBackgroundTaskStatusMessage(primary, runningCount, t);
  const level = backgroundTaskStatusBarLevel(primary.status);
  const title = `${message}\n${t("shell.backgroundTasks.openHint")}`;
  const chipTone =
    level === "success"
      ? "statusbar-chip--ok"
      : level === "error"
        ? "statusbar-chip--danger"
        : "statusbar-chip--progress";

  return (
    <button
      type="button"
      className={`statusbar-chip statusbar-chip--task ${chipTone}`}
      title={title}
      aria-label={message}
      onClick={handleOpenTasks}
      onKeyDown={handleKeyDown}
    >
      {level === "progress" ? (
        <span className="statusbar-chip__pulse" aria-hidden />
      ) : level === "success" ? (
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v4M8 11h.01" strokeLinecap="round" />
        </svg>
      )}
      <span className="statusbar-chip__label">{message}</span>
    </button>
  );
}

/** 订阅当前激活模块的运行日志并展示在状态栏 */
function StatusBarModuleLog() {
  const { t } = useI18n();
  const location = useLocation();
  const [detailOpen, setDetailOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const setActivePublisher = useStatusBarLogStore((s) => s.setActivePublisher);
  const clearLog = useStatusBarLogStore((s) => s.clear);
  const activePublisher = useStatusBarLogStore((s) => s.activePublisher);
  const hasBackgroundTasks = useBackgroundTaskStore(
    (s) => countRunningBackgroundTasks(s.tasks) > 0,
  );
  const logEntry = useStatusBarLogStore((s) => {
    const key = s.activePublisher;
    return key ? s.logsByModule[key] : undefined;
  });

  useEffect(() => {
    setActivePublisher(pathnameToModuleKey(location.pathname));
  }, [location.pathname, setActivePublisher]);

  useEffect(() => {
    setCopied(false);
  }, [logEntry?.id]);

  useEffect(() => {
    if (!logEntry?.message) {
      setDetailOpen(false);
    }
  }, [logEntry?.message]);

  const handleClear = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      if (!activePublisher) return;
      clearLog(activePublisher);
      setDetailOpen(false);
    },
    [activePublisher, clearLog],
  );

  const handleOpenDetail = useCallback(() => {
    setDetailOpen(true);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!logEntry?.message) {
      return;
    }
    try {
      await navigator.clipboard.writeText(logEntry.message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [logEntry?.message]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleOpenDetail();
      }
    },
    [handleOpenDetail],
  );

  if (!logEntry?.message || hasBackgroundTasks) {
    return null;
  }

  return (
    <>
      <span className={`statusbar-log-wrap statusbar-log-wrap--${logEntry.level}`}>
        <button
          type="button"
          className="statusbar-log-clear"
          title={t("shell.statusbar.clearLog")}
          aria-label={t("shell.statusbar.clearLog")}
          onClick={handleClear}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden>
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
        <span
          role="button"
          tabIndex={0}
          className={`statusbar-log statusbar-log--${logEntry.level}`}
          title={`${logEntry.message}\n${t("shell.statusbar.copyLog")}`}
          aria-label={logEntry.message}
          onClick={handleOpenDetail}
          onKeyDown={handleKeyDown}
        >
          {logEntry.level === "progress" ? (
            <span className="statusbar-dot yellow" aria-hidden />
          ) : null}
          <span className="statusbar-log-text">{logEntry.message}</span>
        </span>
      </span>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="statusbar-log-detail-dialog sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("shell.statusbar.logDetail")}</DialogTitle>
          </DialogHeader>
          <pre className="statusbar-log-detail-body">{logEntry.message}</pre>
          <DialogFooter>
            <WorkbenchActionButton type="button" onClick={() => void handleCopy()}>
              {copied ? t("common.copied") : t("common.copy")}
            </WorkbenchActionButton>
            <WorkbenchActionButton type="button" onClick={() => setDetailOpen(false)}>
              {t("common.close")}
            </WorkbenchActionButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StatusBarWorkspacePanelToggle() {
  const { t } = useI18n();
  const workspaceId = useWorkspaceStore((state) => state.workspace.id);
  const embeddedMode = useEmbeddedWorkspaceMode();
  const workspaceDisplayPreference = useBottomPanelStore(
    (state) => state.workspaceDisplayPreference,
  );
  const toggleDisplayMode = useBottomPanelStore(
    (state) => state.toggleWorkspaceDisplayPreference,
  );

  const isPoppedOut = useWorkspaceWindowStore((state) =>
    state.poppedOutIds.includes(workspaceId),
  );
  const isHidden = embeddedMode === "hidden";
  const isTaskBar = workspaceDisplayPreference === "task-bar";

  const toggleLabel = isPoppedOut
    ? t("shell.statusbar.workspacePoppedOutHint")
    : isHidden
      ? t("shell.statusbar.expandWorkspace")
      : isTaskBar
        ? t("shell.statusbar.switchToSplitWindow")
        : t("shell.statusbar.switchToTaskBar");

  return (
    <button
      type="button"
      className={`statusbar-item statusbar-button statusbar-workspace-toggle${!isHidden && !isTaskBar ? " statusbar-workspace-toggle--open" : ""}`}
      onClick={() => toggleDisplayMode()}
      title={toggleLabel}
      aria-label={toggleLabel}
      aria-pressed={!isHidden && !isTaskBar}
      disabled={isPoppedOut}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="1.5" />
        <path d="M3 15h18" />
        {isHidden || isTaskBar ? (
          <polyline points="8 11 12 7 16 11" />
        ) : (
          <polyline points="8 18 12 14 16 18" />
        )}
      </svg>
    </button>
  );
}

function StatusBarWorkspaceControls() {
  const workspaceId = useWorkspaceStore((state) => state.workspace.id);
  const isPoppedOut = useWorkspaceWindowStore((state) =>
    state.poppedOutIds.includes(workspaceId),
  );

  return (
    <div className="statusbar-workspace-controls">
      <WorkspaceSwitcher
        variant="statusbar"
        placement="above"
        context="statusbar"
      />
      {!isPoppedOut ? <StatusBarWorkspacePanelToggle /> : null}
    </div>
  );
}

export function StatusBar() {
  const { t } = useI18n();
  const location = useLocation();
  const activeResourceId = useWorkspaceStore((state) => state.activeResourceId);

  const activeResource = getResourceById(activeResourceId);
  const showWorkspaceControls = !isWorkspacePath(location.pathname);
  const isTerminal = location.pathname === "/module/terminal";
  const terminalState = isTerminal
    ? activeResource?.environment === "local"
      ? t("shell.statusbar.terminalLocalReady")
      : t("shell.statusbar.terminalSshReady")
    : null;

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        <ConnectionPoolIndicator />
        <StatusBarApprovalBadge />
        <StatusBarConflictBadge />
        <StatusBarBackgroundTaskLog />
        <StatusBarModuleLog />
        {terminalState ? <span className="statusbar-meta">{terminalState}</span> : null}
        {isTerminal && activeResource?.name ? (
          <span className="statusbar-meta" title={activeResource.name}>
            {activeResource.name}
          </span>
        ) : null}
      </div>
      <BackgroundTasksWindow />
      <span className="statusbar-spacer" />
      <div className="statusbar-right">
        <StatusBarInfoBar />
        <StatusBarActionBar />
        <StatusBarServicesIndicator />
        {showWorkspaceControls ? <StatusBarWorkspaceControls /> : null}
      </div>
    </div>
  );
}
