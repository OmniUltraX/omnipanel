import { useI18n } from "../../i18n";

export function RouteModuleFallback() {
  const { t } = useI18n();
  return (
    <div className="route-module-fallback" role="status" aria-live="polite">
      {t("common.loading")}
    </div>
  );
}
