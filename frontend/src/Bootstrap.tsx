import { useEffect, useLayoutEffect, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SplashScreen } from "./components/shell/SplashScreen";
import { FirstRunWizard } from "./components/onboarding/FirstRunWizard";
import { SpaceClaimHost, SpaceKeyExportHost } from "./modules/clientSync/spaceClaim";
import { SpaceConflictHost } from "./modules/clientSync/SpaceConflictMark";
import { useI18n } from "./i18n";
import { initSettings, useSettingsStore } from "./stores/settingsStore";
import { commands } from "./ipc/bindings";
import { initConnections } from "./stores/connectionStore";
import { initConnectionPool } from "./stores/connectionPoolStore";
import { initBackgroundTasks } from "./stores/backgroundTaskStore";
import { initAppModuleStore } from "./stores/appModuleStore";
import { initPluginRuntimeStore } from "./stores/pluginRuntimeStore";
import { warmDbxCatalogCache } from "./stores/dbxCatalogStore";
import { initPluginConfirmListener } from "./lib/pluginConfirm";
import { initResourceDedupeListener } from "./lib/resourceDedupeRewrite";
import { initActionListener } from "./stores/actionStore";
import { syncAppWindowTitle } from "./lib/appWindowTitle";
import { dismissHtmlBootSplash } from "./lib/dismissBootSplash";
import { expandMainWindow, showSplashWindow } from "./lib/bootSplashBridge";
import { initDeviceNameCache } from "./lib/deviceIdentity";
import { startBootSecondaryInits } from "./lib/bootSecondaryInits";
import { useAuthStore } from "./stores/authStore";
import { resolveFirstRun } from "./lib/localSpaceBoot";
import { syncAuthProfile } from "./lib/auth/syncAuthProfile";
import "./lib/registerSyncBridges";

const MIN_SPLASH_MS = 800;
const EXIT_ANIM_MS = 520;
const TOTAL_STEPS = 4;
/** 资料同步最多等这么久；超时仍进门，后台继续 */
const PROFILE_SYNC_BUDGET_MS = 1500;

type BootPhase = "wait-auth" | "wizard" | "splash" | "exit" | "app";

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function Bootstrap() {
  const { t } = useI18n();
  const [authReady, setAuthReady] = useState(() => useAuthStore.persist.hasHydrated());
  const [phase, setPhase] = useState<BootPhase>("wait-auth");
  const [AppComponent, setAppComponent] = useState<ComponentType | null>(null);
  const [bootStep, setBootStep] = useState(0);
  const [bootLog, setBootLog] = useState<string | null>(null);
  const [bootErrorMsg, setBootErrorMsg] = useState<string | null>(null);

  useLayoutEffect(() => {
    syncAppWindowTitle();
    dismissHtmlBootSplash();
    // 启动中：固定小窗；登录/失败/退场：放大到正式尺寸
    if (bootErrorMsg || phase === "wizard" || phase === "exit") {
      expandMainWindow();
      return;
    }
    if (phase === "wait-auth" || phase === "splash") {
      const id = requestAnimationFrame(() => {
        showSplashWindow();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [phase, bootErrorMsg]);

  useEffect(() => {
    if (useAuthStore.persist.hasHydrated()) {
      setAuthReady(true);
      return;
    }
    return useAuthStore.persist.onFinishHydration(() => {
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    void resolveFirstRun().then((next) => {
      if (cancelled) return;
      setPhase((prev) => (prev === "wait-auth" ? (next === "wizard" ? "wizard" : "splash") : prev));
    });
    return () => {
      cancelled = true;
    };
  }, [authReady]);

  useEffect(() => {
    if (phase !== "splash") return;

    let cancelled = false;

    async function boot() {
      const started = Date.now();

      const advance = (step: number) => {
        if (!cancelled) setBootStep(step);
      };

      const pushLog = async (message: string) => {
        if (cancelled) return;
        setBootLog(message);
        await wait(16);
      };

      try {
        advance(1);
        // 主界面与重活尽早并行；重活进门后继续，不挡闪屏
        const appPromise = import("./App");

        await pushLog(t("app.splash.logs.settings"));
        initSettings();

        const token = useAuthStore.getState().token;
        // 预热设备名缓存，供工作区创建等同步路径打 creator 标签
        void initDeviceNameCache();

        const proxy = useSettingsStore.getState().proxy;
        await pushLog(t("app.splash.logs.proxy"));
        invoke("set_proxy_config", { config: proxy }).catch(() => {});

        const fileIndexStorageDir = useSettingsStore.getState().fileIndexStorageDir;
        await pushLog(t("app.splash.logs.fileIndex"));
        commands.setFileIndexStorageDir(fileIndexStorageDir).catch(() => {});

        advance(2);
        await pushLog(t("app.splash.logs.modules"));
        await Promise.all([initAppModuleStore(), initPluginRuntimeStore()]);
        warmDbxCatalogCache();
        void initPluginConfirmListener();
        void initResourceDedupeListener();

        if (token) {
          await pushLog(t("app.splash.logs.cloudSync"));
          // 资料同步限时：网络慢时用本地 teams 缓存对齐存储，不把闪屏拖死
          try {
            await Promise.race([syncAuthProfile(), wait(PROFILE_SYNC_BUDGET_MS)]);
          } catch {
            /* syncAuthProfile 已自吞错误；race 仅限时 */
          }
          // 超时后仍让资料请求在后台跑完（写回 profile）
          void syncAuthProfile().catch(() => {});
          try {
            const { alignLocalStorageTeam } = await import("./lib/applyLocalTeamScope");
            await alignLocalStorageTeam();
          } catch {
            /* 对齐失败不挡进门 */
          }
          // 冷启动拉仓库：失败或卡住都不挡进门
          void import("./modules/clientSync")
            .then((m) => {
              if (!m.spaceSyncAutoEnabled()) return;
              return m.pullCloudSnapshot();
            })
            .catch(() => {});
        }

        await pushLog(t("app.splash.logs.connections"));
        await initConnections();

        await pushLog(t("app.splash.logs.connectionPool"));
        initConnectionPool();
        initBackgroundTasks();

        // AI / Agent / SQL / 工具：进门后后台跑，进度走左下角任务条
        startBootSecondaryInits({
          title: t("app.splash.secondaryTask.title"),
          parallel: t("app.splash.secondaryTask.parallel"),
          tools: t("app.splash.secondaryTask.tools"),
          aiModels: t("app.splash.secondaryTask.aiModels"),
          sqlFiles: t("app.splash.secondaryTask.sqlFiles"),
          treeCharts: t("app.splash.secondaryTask.treeCharts"),
          agents: t("app.splash.secondaryTask.agents"),
          dbSchema: t("app.splash.secondaryTask.dbSchema"),
          done: t("app.splash.secondaryTask.done"),
          failed: t("app.splash.secondaryTask.failed"),
        });

        await pushLog(t("app.splash.logs.actionListener"));
        initActionListener();

        advance(3);
        await pushLog(t("app.splash.logs.xterm"));
        await import("@xterm/xterm/css/xterm.css");

        advance(4);
        await pushLog(t("app.splash.logs.appShell"));
        const { default: App } = await appPromise;

        await pushLog(t("app.splash.logs.ready"));

        const remain = MIN_SPLASH_MS - (Date.now() - started);
        if (remain > 0) {
          await wait(remain);
        }

        if (cancelled) return;

        setAppComponent(() => App);
        // 先放大到正式尺寸，再播退场动画进入 App
        expandMainWindow();
        setPhase("exit");
        await wait(EXIT_ANIM_MS);
        setPhase("app");
      } catch (err) {
        if (!cancelled) {
          setBootErrorMsg(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        }
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once per splash entry
  }, [phase]);

  if (phase === "app" && AppComponent) {
    return (
      <>
        <SpaceClaimHost />
        <SpaceKeyExportHost />
        <SpaceConflictHost />
        <AppComponent />
      </>
    );
  }

  if (bootErrorMsg) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "#1a1a1a",
          color: "#ff6b6b",
          padding: 24,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          whiteSpace: "pre-wrap",
          overflow: "auto",
          zIndex: 9999,
        }}
      >
        <div style={{ color: "#fff", marginBottom: 12, fontSize: 16 }}>OmniPanel 启动失败</div>
        {bootErrorMsg}
        <div style={{ color: "#888", marginTop: 16, fontSize: 12 }}>
          详细堆栈请查看 DevTools 控制台（右键 → 检查 / F12）。
        </div>
      </div>
    );
  }

  if (phase === "wizard") {
    return <FirstRunWizard onDone={() => setPhase("splash")} />;
  }

  if (phase === "wait-auth") {
    return (
      <SplashScreen
        step={0}
        totalSteps={TOTAL_STEPS}
        log={t("app.login.checking")}
      />
    );
  }

  return (
    <>
      <SpaceClaimHost />
      <SpaceKeyExportHost />
      <SpaceConflictHost />
      <SplashScreen
        exiting={phase === "exit"}
        step={bootStep}
        totalSteps={TOTAL_STEPS}
        log={bootLog}
      />
    </>
  );
}
