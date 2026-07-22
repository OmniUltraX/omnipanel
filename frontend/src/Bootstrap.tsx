import { useEffect, useState, type ComponentType } from "react";
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
import { selectIsLoggedIn, useAuthStore } from "./stores/authStore";
import { syncAuthProfile } from "./lib/auth/syncAuthProfile";

const MIN_SPLASH_MS = 800;
const EXIT_ANIM_MS = 520;

type BootPhase = "wait-auth" | "login" | "splash" | "exit" | "app";

function removeHtmlBootSplash() {
  dismissHtmlBootSplash();
}

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

  useEffect(() => {
    removeHtmlBootSplash();
    syncAppWindowTitle();
  }, []);

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
        // 尽早启动 App chunk 加载（最大的 JS chunk），与后续 store 初始化并行
        const appPromise = import("./App");

        await pushLog(t("app.splash.logs.settings"));
        initSettings();

        // 已登录时尽早拉资料，侧栏头像不必等打开个人中心
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

        // builtinTools → toolHost 注册有依赖，单独成链
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

        // 以下 store 互相独立，并行初始化
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

        // 未完成加载前可被 Strict Mode cleanup 取消；一旦开始退场就必须落到 app，
        // 否则会停在 splash--exit（透明）造成空白页。
        if (cancelled) return;

        setAppComponent(() => App);
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
    // 仅在进入 splash 时启动；t 变化不应打断/重跑启动流程
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
        totalSteps={4}
        log={t("app.login.checking")}
      />
    );
  }

  return (
    <SplashScreen
      exiting={phase === "exit"}
      step={bootStep}
      totalSteps={4}
      log={bootLog}
    />
  );
}
