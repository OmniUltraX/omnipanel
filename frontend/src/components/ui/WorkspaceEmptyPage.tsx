import { useI18n } from "../../i18n";
import { AppLogo } from "./AppLogo";

export interface WorkspaceEmptyPageProps {
  /** 上下文提示，显示在 Banner 下方 */
  hint?: string;
  className?: string;
}

/** 工作区无内容时的通用空页面：品牌 Logo、名称与 Banner。 */
export function WorkspaceEmptyPage({ hint, className }: WorkspaceEmptyPageProps) {
  const { t } = useI18n();
  const rootClass = className
    ? `workspace-empty-page ${className}`
    : "workspace-empty-page";

  return (
    <div className={rootClass}>
      <div className="workspace-empty-page__logo" aria-hidden>
        <AppLogo size={56} className="app-logo app-logo--hero" />
      </div>
      <h1 className="workspace-empty-page__name">{t("routes.default")}</h1>
      <p className="workspace-empty-page__tagline">{t("app.tagline")}</p>
      <div className="workspace-empty-page__banner" role="presentation">
        {t("app.banner")}
      </div>
      {hint ? <p className="workspace-empty-page__hint">{hint}</p> : null}
    </div>
  );
}
