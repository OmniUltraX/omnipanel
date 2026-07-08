import type { ReactNode } from "react";
import { useI18n } from "../../../i18n";
import { AppLogo } from "../layout/AppLogo";

export interface WorkspaceEmptyActionItem {
  id: string;
  label: string;
  meta?: string;
  onClick: () => void;
}

export interface WorkspaceEmptyPageProps {
  /** 主标题，默认使用应用名称 */
  title?: string;
  /** 模块上下文提示语，显示在 Banner 下方 */
  prompt?: string;
  /** 提示语下方的操作区（如主操作按钮） */
  actions?: ReactNode;
  /** 列表形式的操作区（如最近关闭的面板） */
  actionList?: {
    title?: string;
    items: WorkspaceEmptyActionItem[];
  };
  className?: string;
  /** 隐藏 Logo、标题、标语与 Banner（半屏嵌入用） */
  hideBranding?: boolean;
}

/** 工作区无内容时的通用空页面：品牌 Logo、名称与 Banner。 */
export function WorkspaceEmptyPage({
  title,
  prompt,
  actions,
  actionList,
  className,
  hideBranding = false,
}: WorkspaceEmptyPageProps) {
  const { t } = useI18n();
  const rootClass = [
    "workspace-empty-page",
    className,
    hideBranding ? "workspace-empty-page--no-branding" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClass}>
      {!hideBranding ? (
        <>
          <div className="workspace-empty-page__logo" aria-hidden>
            <AppLogo size={56} className="app-logo app-logo--hero" />
          </div>
          <h1 className="workspace-empty-page__name">{title ?? t("routes.default")}</h1>
          <p className="workspace-empty-page__tagline">{t("app.tagline")}</p>
          <div className="workspace-empty-page__banner" role="presentation">
            {t("app.banner")}
          </div>
        </>
      ) : null}
      {prompt ? <p className="workspace-empty-page__prompt">{prompt}</p> : null}
      {actions ? <div className="workspace-empty-page__actions">{actions}</div> : null}
      {actionList && actionList.items.length > 0 ? (
        <div className="workspace-empty-page__action-list">
          {actionList.title ? (
            <p className="workspace-empty-page__action-list-title">{actionList.title}</p>
          ) : null}
          <ul className="workspace-empty-page__action-list-items" role="list">
            {actionList.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="workspace-empty-page__action-item"
                  onClick={item.onClick}
                >
                  <span className="workspace-empty-page__action-item-label">{item.label}</span>
                  {item.meta ? (
                    <span className="workspace-empty-page__action-item-meta">{item.meta}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

