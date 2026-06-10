import { useEffect, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SplashScreen } from "./components/shell/SplashScreen";
import { initSettings, useSettingsStore } from "./stores/settingsStore";
import { initAiModelsStore } from "./stores/aiModelsStore";
import { initConnections } from "./stores/connectionStore";
import { initActionListener } from "./stores/actionStore";

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
  const [phase, setPhase] = useState<BootPhase>("splash");
  const [AppComponent, setAppComponent] = useState<ComponentType | null>(null);
  const [bootStep, setBootStep] = useState(0);
  const [bootErrorMsg, setBootErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    removeHtmlBootSplash();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      const started = Date.now();

      const advance = (step: number) => {
        if (!cancelled) setBootStep(step);
      };

      try {
        advance(1);
        initSettings();

        const proxy = useSettingsStore.getState().proxy;
        if (proxy.enabled) {
          invoke("set_proxy_config", { config: proxy }).catch(() => {});
        }

        advance(2);
        initConnections();
        initActionListener();
        await initAiModelsStore();

        advance(3);
        await import("./lib/monacoSetup");
        await import("@xterm/xterm/css/xterm.css");

        advance(4);
        const { default: App } = await import("./App");

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
  }, []);

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
    />
  );
}
