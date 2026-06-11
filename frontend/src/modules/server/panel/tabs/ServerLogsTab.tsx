import { useI18n } from "../../../../i18n";
import type { ServerEntry } from "../serverConnection";

interface Props {
  server: ServerEntry;
}

export function ServerLogsTab(_props: Props) {
  const { t } = useI18n();

  return (
    <div className="server-panel-tab">
      <div className="server-panel-tab-toolbar">
        <span className="server-panel-tab-title">{t("server.tabs.logs")}</span>
      </div>
      <div className="server-apps-empty">
        <p>{t("server.logs.hint")}</p>
        <p className="text-muted text-sm">{t("server.logs.appsHint")}</p>
      </div>
    </div>
  );
}
