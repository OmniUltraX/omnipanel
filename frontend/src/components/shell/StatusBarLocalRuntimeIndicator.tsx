import { useEffect, useState } from "react";

import { commands, type LocalRuntimeStatus } from "../../ipc/bindings";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import { useI18n } from "../../i18n";

type LocalDotLevel = "ok" | "warn" | "off";

function levelFor(status: LocalRuntimeStatus | null, lms: boolean): LocalDotLevel {
  if (status === "running") return "ok";
  if (lms) return "ok";
  if (status === "installed_not_running") return "warn";
  return "off";
}

/** 状态栏本地运行时（Ollama / LM Studio）指示点 */
export function StatusBarLocalRuntimeIndicator() {
  const { t } = useI18n();
  const [ollamaStatus, setOllamaStatus] = useState<LocalRuntimeStatus | null>(null);
  const [lmsOk, setLmsOk] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const probe = commands.localRuntimeProbe;
    if (typeof probe !== "function") return;

    const check = () => {
      void probe()
        .then((res) => {
          if (res.status !== "ok") {
            setOllamaStatus(null);
            setLmsOk(false);
            return;
          }
          setOllamaStatus(res.data.ollama.status);
          setLmsOk(res.data.lmStudio.reachable);
        })
        .catch(() => {
          setOllamaStatus(null);
          setLmsOk(false);
        });
    };

    check();
    const timer = window.setInterval(check, 20000);
    return () => window.clearInterval(timer);
  }, []);

  const level = levelFor(ollamaStatus, lmsOk);
  const className =
    level === "ok"
      ? "statusbar-dot green"
      : level === "warn"
        ? "statusbar-dot yellow"
        : "statusbar-dot";

  const statusKey = ollamaStatus ?? "not_installed";
  const title = t("shell.statusbar.localRuntime.tooltip", {
    ollama: t(`settings.localModels.status.${statusKey}`),
    lms: lmsOk
      ? t("settings.localModels.lmsOnline")
      : t("settings.localModels.lmsOffline"),
  });

  return <span className={className} title={title} aria-label={title} />;
}
