import { useEffect, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SplashScreen } from "./components/shell/SplashScreen";
import { useI18n } from "./i18n";
import { initSettings, useSettingsStore } from "./stores/settingsStore";
import { commands } from "./ipc/bindings";
import { initAiModelsStore } from "./stores/aiModelsStore";
import { initDbSqlFilesStore } from "./stores/dbSqlFileStore";
import { initAcpServicesStore } from "./stores/acpServicesStore";
import { initConnections } from "./stores/connectionStore";
import { initConnectionPool } from "./stores/connectionPoolStore";
import { initBackgroundTasks } from "./stores/backgroundTaskStore";
import { initAppModuleStore } from "./stores/appModuleStore";
import { initMcpToolStore } from "./stores/mcpToolStore";
import { initActionListener } from "./stores/actionStore";
import { syncAppWindowTitle } from "./lib/appWindowTitle";

const MIN_SPLASH_MS = 1400;
const EXIT_ANIM_MS = 520;

type BootPhase = "splash" | "exit" | "app";

function removeHtmlBootSplash() {
  document.getElementById("boot-splash")?.remove();
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function Bootstrap() {
  const { t } = useI18n();
  const [phase, setPhase] = useState<BootPhase>("splash");
  const [AppComponent, setAppComponent] = useState<ComponentType | null>(null);
  const [bootStep, setBootStep] = useState(0);
  const [bootLog, setBootLog] = useState<string | null>(null);
  const [bootErrorMsg, setBootErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    removeHtmlBootSplash();
    syncAppWindowTitle();
  }, []);

  useEffect(() => {
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
        await pushLog(t("app.splash.logs.settings"));
        initSettings();

        const proxy = useSettingsStore.getState().proxy;
        if (proxy.enabled) {
          await pushLog(t("app.splash.logs.proxy"));
          invoke("set_proxy_config", { config: proxy }).catch(() => {});
        }

        const fileIndexStorageDir = useSettingsStore.getState().fileIndexStorageDir;
        await pushLog(t("app.splash.logs.fileIndex"));
        commands.setFileIndexStorageDir(fileIndexStorageDir).catch(() => {});

        advance(2);
        await pushLog(t("app.splash.logs.modules"));
        await initAppModuleStore();

        await pushLog(t("app.splash.logs.mcpTools"));
        await initMcpToolStore();

        await pushLog(t("app.splash.logs.connections"));
        initConnections();

        await pushLog(t("app.splash.logs.connectionPool"));
        initConnectionPool();
        initBackgroundTasks();

        await pushLog(t("app.splash.logs.actionListener"));
        initActionListener();

        await pushLog(t("app.splash.logs.aiModels"));
        await initAiModelsStore();

        await pushLog(t("app.splash.logs.sqlFiles"));
        await initDbSqlFilesStore();

        await pushLog(t("app.splash.logs.acpServices"));
        await initAcpServicesStore();

        advance(3);
        await pushLog(t("app.splash.logs.xterm"));
        await import("@xterm/xterm/css/xterm.css");

        advance(4);
        await pushLog(t("app.splash.logs.appShell"));
        const { default: App } = await import("./App");

        await pushLog(t("app.splash.logs.ready"));

        const remain = MIN_SPLASH_MS - (Date.now() - started);
        if (remain > 0) {
          await wait(remain);
        }

        if (cancelled) return;

        setAppComponent(() => App);
        setPhase("exit");
        await wait(EXIT_ANIM_MS);

        if (cancelled) return;
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
  }, [t]);

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

  return (
    <SplashScreen
      exiting={phase === "exit"}
      step={bootStep}
      totalSteps={4}
      log={bootLog}
    />
  );
}
