import { useEffect, useLayoutEffect, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SplashScreen } from "./components/shell/SplashScreen";
import { LoginPage } from "./components/user/LoginPage";
import { useI18n } from "./i18n";
import { initSettings, useSettingsStore } from "./stores/settingsStore";
import { commands } from "./ipc/bindings";
import { initAiModelsStore } from "./stores/aiModelsStore";
import { initDbSqlFilesStore } from "./stores/dbSqlFileStore";
import { initDbTreeChartFilesStore } from "./stores/dbTreeChartFileStore";
import { initAcpServicesStore } from "./stores/acpServicesStore";
import { initCliProvidersStore } from "./stores/cliProvidersStore";
import { initConnections } from "./stores/connectionStore";
import { initConnectionPool } from "./stores/connectionPoolStore";
import { initBackgroundTasks } from "./stores/backgroundTaskStore";
import { initAppModuleStore } from "./stores/appModuleStore";
import { initBuiltinToolStore } from "./stores/builtinToolStore";
import { initActionListener } from "./stores/actionStore";
import { syncAppWindowTitle } from "./lib/appWindowTitle";
import { dismissHtmlBootSplash } from "./lib/dismissBootSplash";
import { expandMainWindow, showSplashWindow } from "./lib/bootSplashBridge";
import { selectIsLoggedIn, useAuthStore } from "./stores/authStore";
import { syncAuthProfile } from "./lib/auth/syncAuthProfile";

const MIN_SPLASH_MS = 800;
const EXIT_ANIM_MS = 520;
const TOTAL_STEPS = 4;

type BootPhase = "wait-auth" | "login" | "splash" | "exit" | "app";

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function Bootstrap() {
  const { t } = useI18n();
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
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
    if (bootErrorMsg || phase === "login" || phase === "exit") {
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
    if (isLoggedIn) {
      setPhase((prev) => (prev === "wait-auth" || prev === "login" ? "splash" : prev));
      return;
    }
    setPhase((prev) => (prev === "wait-auth" ? "login" : prev));
  }, [authReady, isLoggedIn]);

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
        const appPromise = import("./App");

        await pushLog(t("app.splash.logs.settings"));
        initSettings();

        const token = useAuthStore.getState().token;
        const profileSync = token ? syncAuthProfile() : Promise.resolve();

        const proxy = useSettingsStore.getState().proxy;
        await pushLog(t("app.splash.logs.proxy"));
        invoke("set_proxy_config", { config: proxy }).catch(() => {});

        const fileIndexStorageDir = useSettingsStore.getState().fileIndexStorageDir;
        await pushLog(t("app.splash.logs.fileIndex"));
        commands.setFileIndexStorageDir(fileIndexStorageDir).catch(() => {});

        advance(2);
        await pushLog(t("app.splash.logs.modules"));
        await initAppModuleStore();

        await pushLog(t("app.splash.logs.builtinTools"));
        const toolsChain = initBuiltinToolStore().then(async () => {
          const { registerToolHandlers } = await import("./lib/ai/toolHost");
          registerToolHandlers();
          const { syncGatewayConfig } = await import("./lib/ai/gatewayConfig");
          void syncGatewayConfig();
        });

        await pushLog(t("app.splash.logs.connections"));
        await initConnections();

        await pushLog(t("app.splash.logs.connectionPool"));
        initConnectionPool();
        initBackgroundTasks();

        await pushLog(t("app.splash.logs.actionListener"));
        initActionListener();

        await pushLog(t("app.splash.logs.aiModels"));
        const parallelInits = Promise.all([
          initAiModelsStore(),
          initDbSqlFilesStore(),
          initDbTreeChartFilesStore(),
          initAcpServicesStore(),
          initCliProvidersStore(),
          import("./modules/database/schema/initDbSchemaUiStores").then((m) =>
            m.initDbSchemaUiStores(),
          ),
          profileSync,
        ]);
        await Promise.all([toolsChain, parallelInits]);

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
    return <AppComponent />;
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

  if (phase === "login") {
    return <LoginPage />;
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
    <SplashScreen
      exiting={phase === "exit"}
      step={bootStep}
      totalSteps={TOTAL_STEPS}
      log={bootLog}
    />
  );
}
