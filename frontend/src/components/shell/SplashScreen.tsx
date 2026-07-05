import { useMemo } from "react";
import { AppLogo } from "../ui/layout/AppLogo";
import { useI18n } from "../../i18n";

export interface SplashScreenProps {
  exiting?: boolean;
  /** 0–totalSteps，表示当前启动阶段 */
  step?: number;
  totalSteps?: number;
  /** 当前正在执行的启动任务（单行展示） */
  log?: string | null;
}

export function SplashScreen({
  exiting = false,
  step = 0,
  totalSteps = 4,
  log = null,
}: SplashScreenProps) {
  const { t } = useI18n();

  const stepLabels = useMemo(
    () => [
      t("app.splash.steps.runtime"),
      t("app.splash.steps.connections"),
      t("app.splash.steps.editor"),
      t("app.splash.steps.workspace"),
    ],
    [t],
  );

  const progress = totalSteps > 0 ? Math.min(100, Math.round((step / totalSteps) * 100)) : 0;
  const activeLabel =
    step > 0 && step <= stepLabels.length
      ? stepLabels[step - 1]
      : t("app.splash.steps.runtime");

  const detailLine = log ?? t("app.splash.logsPending");

  return (
    <div
      className={`splash${exiting ? " splash--exit" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={t("app.splash.loading")}
    >
      <div className="splash__bg" aria-hidden>
        <div className="splash__grid" />
        <div className="splash__glow splash__glow--a" />
        <div className="splash__glow splash__glow--b" />
        <div className="splash__scanline" />
      </div>

      <div className="splash__content">
        <div className="splash__logo-wrap">
          <div className="splash__logo-ring" aria-hidden />
          <div className="splash__logo-core">
            <AppLogo size={72} className="splash__logo" />
          </div>
        </div>

        <h1 className="splash__title">OmniPanel</h1>
        <p className="splash__tagline">{t("app.tagline")}</p>
        <p className="splash__banner">{t("app.banner")}</p>

        <div className="splash__status">
          <span className="splash__status-dot" aria-hidden />
          <span className="splash__status-text">{activeLabel}</span>
        </div>

        <div className="splash__progress" aria-hidden>
          <div className="splash__progress-track">
            <div className="splash__progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="splash__progress-pct">{progress}%</span>
        </div>

        <p className="splash__log" aria-live="polite">
          <span className="splash__log-prefix" aria-hidden>
            ›
          </span>
          {detailLine}
        </p>
      </div>
    </div>
  );
}
