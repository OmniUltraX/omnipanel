import {
  Component,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { WindowResize } from "./components/shell/WindowResize";
import { QuickInputHost } from "./components/ui/form/QuickInputHost";
import { AppDialogHost } from "./components/ui/overlay/AppDialogHost";
import { ToastHost } from "./components/ui/feedback/ToastHost";
import { SubWindowMinimizedStack } from "./components/ui/window/SubWindowMinimizedStack";
import { AiDrawer } from "./components/ai/AiDrawer";
import { AiDockView } from "./components/ai/AiDockView";
import { AiDockviewResizeHandle } from "./components/ai/AiDockviewResizeHandle";
import { AiRuntimeProvider } from "./components/ai/assistant-ui/AiRuntimeProvider";
import { ApprovalDialog } from "./components/ai/ApprovalDialog";
import { SettingsWindow } from "./components/settings/SettingsWindow";
import { ModuleVisibilityProvider } from "./lib/moduleVisibility";
import { MODULE_PATHS, moduleKeyFromPath, type ModuleKey } from "./lib/paths";
import { dismissHtmlBootSplash } from "./lib/dismissBootSplash";
import { syncAppWindowTitle } from "./lib/appWindowTitle";
import {
  relayoutDockviewInstances,
  scheduleRebalanceHorizontalSplitsForAiDock,
} from "./lib/dockviewRegistry";
import { initSettings, useSettingsStore } from "./stores/settingsStore";
import { initConnections } from "./stores/connectionStore";
import { initConnectionPool } from "./stores/connectionPoolStore";
import { initAppModuleStore } from "./stores/appModuleStore";
import { initPluginRuntimeStore } from "./stores/pluginRuntimeStore";
import { warmDbxCatalogCache } from "./stores/dbxCatalogStore";
import { useAiStore } from "./stores/aiStore";
import { useAiDrawerShortcut } from "./hooks/useAiDrawerShortcut";
import { useSettingsShortcut } from "./hooks/useSettingsShortcut";
import {
  LazyDatabasePanel,
  LazyDockerPanel,
  LazyFilesPanel,
  LazyKnowledgePanel,
  LazyProtocolPanel,
  LazyServerPanel,
  LazySshPanel,
  LazyTaskCenterPanel,
  LazyTerminalPanel,
  LazyWorkflowPanel,
  LazyCloudPanel,
} from "./routes/lazyModules";
import { useI18n } from "./i18n";
import { listenModuleWindowShown } from "./lib/moduleWindow";
import { attachSnapMaximizeButton, OMNIPANEL_SNAP_MAXIMIZE_ID } from "./lib/snapLayout";
import { registerUiFollowNavigate } from "./lib/ai/uiFollow";
import { initModuleQuickLauncherActionListener } from "./lib/quickLauncherActions";
import {
  initAppearanceSyncSubscriber,
  requestAppearanceSync,
} from "./lib/appearanceSync";

/** 模块窗内：注册 follow 导航 + 接收快捷启动 SOLO 动作。 */
function ModuleWindowIpcBridge({ moduleKey }: { moduleKey: ModuleKey }) {
  const navigate = useNavigate();

  useEffect(() => {
    return registerUiFollowNavigate((path) => {
      // 独立窗只允许本模块路径；跨模块 navigate 会让 isActiveRoute 变 false 并藏掉顶栏
      const target = moduleKeyFromPath(path);
      if (target !== moduleKey) return;
      navigate(path);
    });
  }, [navigate, moduleKey]);

  useEffect(() => {
    return initModuleQuickLauncherActionListener(moduleKey);
  }, [moduleKey]);

  return null;
}

const MODULE_WINDOW_PANELS: Record<ModuleKey, ComponentType> = {
  terminal: LazyTerminalPanel,
  database: LazyDatabasePanel,
  docker: LazyDockerPanel,
  ssh: LazySshPanel,
  server: LazyServerPanel,
  protocol: LazyProtocolPanel,
  workflow: LazyWorkflowPanel,
  knowledge: LazyKnowledgePanel,
  files: LazyFilesPanel,
  tasks: LazyTaskCenterPanel,
  cloud: LazyCloudPanel,
};

interface ModuleWindowRootProps {
  moduleKey: ModuleKey;
}

class ModuleWindowErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error: error?.stack || error?.message || String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[moduleWindow] render crash", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="module-window module-window--error">
          <pre className="module-window-error">{this.state.error}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

async function waitPersistHydrated(
  store: {
    persist: {
      hasHydrated: () => boolean;
      onFinishHydration: (fn: () => void) => () => void;
    };
  },
  timeoutMs = 400,
): Promise<void> {
  if (store.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const unsub = store.persist.onFinishHydration(() => {
      unsub();
      resolve();
    });
    window.setTimeout(() => {
      unsub();
      resolve();
    }, timeoutMs);
  });
}

/**
 * 模块独立窗口：无左侧 Sidebar，仅顶栏 + 模块面板。
 * 先出壳渲染面板，store / AI 在后台初始化，不阻塞首屏。
 */
export function ModuleWindowRoot({ moduleKey }: ModuleWindowRootProps) {
  return (
    <ModuleWindowErrorBoundary>
      <ModuleWindowBoot moduleKey={moduleKey} />
    </ModuleWindowErrorBoundary>
  );
}

function ModuleWindowBoot({ moduleKey }: ModuleWindowRootProps) {
  const { t } = useI18n();
  const title = t(`shell.nav.${moduleKey}`);
  const modulePath = MODULE_PATHS[moduleKey];
  const Panel = MODULE_WINDOW_PANELS[moduleKey];
  const workspaceRef = useRef<HTMLDivElement>(null);

  const aiDisplayMode = useSettingsStore((s) => s.aiDisplayMode);
  const aiDockWidth = useSettingsStore((s) => s.aiDockWidth);
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  const aiDockview = aiDisplayMode === "dockview";
  const dockOpen = aiDockview && drawerOpen;
  const dockWidth = dockOpen ? `${aiDockWidth}px` : "0px";

  useAiDrawerShortcut();
  useSettingsShortcut();

  // 与主窗 WorkspaceShell 一致：AI 侧栏开合/调宽后强制 dockview relayout
  useLayoutEffect(() => {
    const dock = workspaceRef.current?.querySelector<HTMLElement>(".ai-dockview");
    if (!dockOpen && dock) {
      dock.style.width = "";
    }
    relayoutDockviewInstances();
    scheduleRebalanceHorizontalSplitsForAiDock();
  }, [dockOpen, dockWidth]);

  useEffect(() => {
    dismissHtmlBootSplash();
    document.documentElement.classList.add("module-window-root");
    document.body.classList.add("module-window-body");
    // 独立 data_directory：主题须经主窗 appearanceSync，不能靠本窗 localStorage
    initSettings();
    const unsubAppearance = initAppearanceSyncSubscriber();
    return () => {
      unsubAppearance();
      document.documentElement.classList.remove("module-window-root");
      document.body.classList.remove("module-window-body");
    };
  }, []);

  useEffect(() => {
    syncAppWindowTitle(title);
  }, [title]);

  // 先出壳：关键 init 不阻塞面板挂载；隐藏后再打开时刷连接列表
  useEffect(() => {
    let cancelled = false;

    const bootBackground = async () => {
      try {
        initConnectionPool();

        // 关键路径并行；hydrate 超时缩短，避免空等
        await Promise.all([
          initAppModuleStore().catch(() => {}),
          initPluginRuntimeStore().catch(() => {}),
          initConnections().catch(() => {}),
          import("./stores/settingsStore").then(({ useSettingsStore }) =>
            waitPersistHydrated(useSettingsStore, 400),
          ),
        ]);
        warmDbxCatalogCache();

        if (cancelled) return;

        // AI / 数据库持久化：与面板并行，失败不阻断 UI
        const secondary: Array<Promise<unknown>> = [
          import("./stores/aiModelsStore")
            .then(({ initAiModelsStore }) => initAiModelsStore())
            .catch(() => {}),
          import("./stores/builtinToolStore")
            .then(({ initBuiltinToolStore }) => initBuiltinToolStore())
            .then(async () => {
              const { registerToolHandlers } = await import("./lib/ai/toolHost");
              registerToolHandlers();
            })
            .catch(() => {}),
        ];

        if (moduleKey === "database") {
          secondary.push(
            Promise.all([
              import("./stores/dbSqlFileStore"),
              import("./stores/dbTreeChartFileStore"),
            ]).then(async ([{ initDbSqlFilesStore }, { initDbTreeChartFilesStore }]) => {
              await Promise.all([
                initDbSqlFilesStore().catch(() => {}),
                initDbTreeChartFilesStore().catch(() => {}),
                import("./modules/database/schema/initDbSchemaUiStores").then((m) =>
                  m.initDbSchemaUiStores(),
                ),
              ]);
            }),
          );
        }

        if (moduleKey === "terminal" || moduleKey === "ssh") {
          secondary.push(import("@xterm/xterm/css/xterm.css").catch(() => {}));
        }

        if (moduleKey === "tasks") {
          secondary.push(
            import("./stores/backgroundTaskStore")
              .then(({ initBackgroundTasks }) => {
                initBackgroundTasks();
              })
              .catch(() => {}),
          );
        }

        await Promise.all(secondary);
      } catch (e) {
        // 后台 init 失败不拆掉已挂载面板，仅打日志
        console.error("[moduleWindow] background boot failed", e);
      }
    };

    void bootBackground();

    let unlistenShown: (() => void) | undefined;
    const shownAbort = new AbortController();
    void listenModuleWindowShown((payload) => {
      if (payload.moduleKey !== moduleKey) return;
      void requestAppearanceSync();
      void initConnections().catch(() => {});
      // 隐藏→显示后重绑 Snap overlay（其它模块窗冷开常见未挂上）
      const btn = document.getElementById(OMNIPANEL_SNAP_MAXIMIZE_ID);
      void attachSnapMaximizeButton(btn, { signal: shownAbort.signal });
    }).then((unlisten) => {
      unlistenShown = unlisten;
    });

    return () => {
      cancelled = true;
      shownAbort.abort();
      unlistenShown?.();
    };
  }, [moduleKey]);

  return (
    <AiRuntimeProvider>
      <MemoryRouter initialEntries={[modulePath]} initialIndex={0}>
        <ModuleWindowIpcBridge moduleKey={moduleKey} />
        <div className="module-window" data-ready="1" data-module={moduleKey}>
          {/* 复用主窗 .workspace 结构，使 AI dockview / 内容区 margin 样式生效 */}
          <div
            ref={workspaceRef}
            className="workspace module-window__workspace"
            style={{ "--ai-dock-w": dockWidth } as React.CSSProperties}
          >
            <div className="workspace-body">
              <div className="content-area module-window__content">
                <div className="route-panel route-panel--overlay route-panel--active route-panel--keep-layout">
                  <ModuleVisibilityProvider active suspended={false}>
                    <Suspense
                      fallback={
                        <div className="module-window__loading">
                          {t("shell.nav.moduleWindowLoading")}
                        </div>
                      }
                    >
                      <Panel />
                    </Suspense>
                  </ModuleVisibilityProvider>
                </div>
              </div>
              {dockOpen ? <AiDockviewResizeHandle workspaceRef={workspaceRef} /> : null}
              {aiDockview ? <AiDockView /> : null}
            </div>
          </div>
          {!aiDockview ? <AiDrawer /> : null}
          <ApprovalDialog />
          <SettingsWindow />
          <SubWindowMinimizedStack />
          <WindowResize />
          <QuickInputHost />
          <AppDialogHost />
          <ToastHost />
        </div>
      </MemoryRouter>
    </AiRuntimeProvider>
  );
}
