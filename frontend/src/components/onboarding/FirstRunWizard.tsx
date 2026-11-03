import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import { useAuthStore } from "../../stores/authStore";
import { syncFromOpenSshConfig, useConnectionStore } from "../../stores/connectionStore";
import { AppLogo } from "../ui/layout/AppLogo";
import { WinControls } from "../shell/WinControls";
import { usesMacTrafficLights } from "../../lib/platform";
import { WorkbenchActionButton } from "../ui/primitives/WorkbenchActionButton";
import { TextInput } from "../ui/form/TextInput";
import { AuthLoginMethods } from "../user/AuthLoginMethods";

type StepId = "welcome" | "name" | "import" | "login";

interface ImportSource {
  id: "ssh" | "docker" | "navicat";
  label: string;
  checked: boolean;
  aliases?: string[];
}

interface FirstRunWizardProps {
  onDone: () => void;
}

export function FirstRunWizard({ onDone }: FirstRunWizardProps) {
  const { t } = useI18n();
  const mac = usesMacTrafficLights();
  const token = useAuthStore((s) => s.token);
  const [step, setStep] = useState<StepId>("welcome");
  const [name, setName] = useState(() => t("app.onboarding.spaceDefault"));
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found: ImportSource[] = [];
      try {
        const ssh = await commands.sshListConfigHosts();
        if (ssh.status === "ok" && ssh.data.length > 0) {
          found.push({
            id: "ssh",
            label: t("app.onboarding.importSsh", { count: ssh.data.length }),
            checked: true,
            aliases: ssh.data.map((host) => host.alias),
          });
        }
      } catch {
        /* 读不到 SSH 配置就不当作一个来源 */
      }
      try {
        const docker = await commands.dockerGetLocalEngineStatus();
        if (docker.status === "ok" && docker.data.installed) {
          found.push({
            id: "docker",
            label: t("app.onboarding.importDocker"),
            checked: true,
          });
        }
      } catch {
        /* 探测失败就不当作一个来源 */
      }
      try {
        const navicat = await commands.localSpaceNavicatPresent();
        if (navicat.status === "ok" && navicat.data) {
          found.push({
            id: "navicat",
            label: t("app.onboarding.importNavicat"),
            checked: true,
          });
        }
      } catch {
        /* 探测失败就不当作一个来源 */
      }
      if (!cancelled) setSources(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    if (step === "login" && token?.trim()) {
      void finish();
    }
    // finish 只在登录成功时走一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, step]);

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await commands.localSpaceComplete(name.trim() || t("app.onboarding.spaceDefault"));
    } catch {
      /* 空间行写失败不挡进工作台，本机数据还在 */
    }
    onDone();
  };

  const importSelected = async () => {
    const selected = (sources ?? []).filter((source) => source.checked);
    for (const source of selected) {
      if (source.id === "ssh") {
        await syncFromOpenSshConfig(source.aliases ?? []);
      }
      if (source.id === "navicat") {
        sessionStorage.setItem("omnipanel.navicatImport", "1");
      }
      if (source.id === "docker") {
        const listed = await commands.connList();
        const hasLocal =
          listed.status === "ok" &&
          listed.data.some((conn) => {
            if (conn.kind !== "docker") return false;
            try {
              const parsed = JSON.parse(conn.config || "{}") as { source?: string };
              return parsed.source === "local-engine";
            } catch {
              return false;
            }
          });
        if (!hasLocal) {
          await useConnectionStore.getState().save({
            id: "",
            kind: "docker",
            name: t("app.onboarding.importDocker"),
            envTag: "dev",
            config: JSON.stringify({ source: "local-engine" }),
          });
        }
      }
    }
  };

  const goNext = async () => {
    if (step === "welcome") {
      setStep("name");
      return;
    }
    if (step === "name") {
      if (sources === null) return;
      setStep(sources.length > 0 ? "import" : "login");
      return;
    }
    if (step === "import") {
      setBusy(true);
      try {
        await importSelected();
      } finally {
        setBusy(false);
      }
      setStep("login");
    }
  };

  const goBack = () => {
    if (step === "name") setStep("welcome");
    else if (step === "import") setStep("name");
    else if (step === "login") setStep(sources && sources.length > 0 ? "import" : "name");
  };

  return (
    <div
      className={`login-page login-page--onboarding${step === "login" ? " login-page--onboarding-login" : ""}`}
      role="main"
      aria-label={t("app.onboarding.welcomeTitle")}
    >
      <div className="splash__bg" aria-hidden>
        <div className="splash__grid" />
        <div className="splash__glow splash__glow--a" />
        <div className="splash__glow splash__glow--b" />
        <div className="splash__scanline" />
      </div>

      <div
        className={`login-page__chrome${mac ? " login-page__chrome--mac" : ""}`}
        data-tauri-drag-region
      >
        {mac ? <WinControls className="login-page__win-controls" /> : null}
        <div className="login-page__chrome-drag" data-tauri-drag-region aria-hidden />
        {!mac ? <WinControls className="login-page__win-controls" /> : null}
      </div>

      <div className="login-page__content">
        <div className="login-page__brand">
          <AppLogo size={56} className="login-page__logo" />
          <h1 className="login-page__title">OmniPanel</h1>
          <p className="login-page__tagline">{t("app.tagline")}</p>
        </div>

        <div className="login-page__card onboarding-card">
          {step === "welcome" ? (
            <>
              <h2 className="login-page__card-title">{t("app.onboarding.welcomeTitle")}</h2>
              <p className="login-page__card-desc">{t("app.onboarding.welcomeBody")}</p>
            </>
          ) : null}

          {step === "name" ? (
            <>
              <h2 className="login-page__card-title">{t("app.onboarding.spaceTitle")}</h2>
              <p className="login-page__card-desc">{t("app.onboarding.spaceBody")}</p>
              <label className="onboarding-field">
                <span>{t("app.onboarding.spaceName")}</span>
                <TextInput value={name} onChange={setName} copyable={false} size="sm" />
              </label>
            </>
          ) : null}

          {step === "import" ? (
            <>
              <h2 className="login-page__card-title">{t("app.onboarding.importTitle")}</h2>
              <p className="login-page__card-desc">{t("app.onboarding.importBody")}</p>
              {(sources ?? []).map((source) => (
                <label key={source.id} className="onboarding-check">
                  <input
                    type="checkbox"
                    checked={source.checked}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSources((prev) =>
                        (prev ?? []).map((item) =>
                          item.id === source.id ? { ...item, checked } : item,
                        ),
                      );
                    }}
                  />
                  <span>{source.label}</span>
                </label>
              ))}
            </>
          ) : null}

          {step === "login" ? <AuthLoginMethods brief /> : null}

          <div className="onboarding-actions">
            {step === "login" ? (
              <WorkbenchActionButton
                className="onboarding-skip"
                disabled={busy}
                onClick={() => void finish()}
              >
                {t("app.onboarding.skip")}
              </WorkbenchActionButton>
            ) : (
              <WorkbenchActionButton
                className="onboarding-next"
                disabled={busy || ((step === "name" || step === "import") && sources === null)}
                onClick={() => void goNext()}
              >
                {step === "welcome" ? t("app.onboarding.start") : t("app.onboarding.continue")}
              </WorkbenchActionButton>
            )}
            {step !== "welcome" ? (
              <WorkbenchActionButton className="onboarding-back" disabled={busy} onClick={goBack}>
                {t("app.onboarding.back")}
              </WorkbenchActionButton>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
