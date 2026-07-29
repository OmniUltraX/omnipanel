import { SubWindow } from "../ui/window/SubWindow";
import { useDataSyncUiStore } from "../../stores/dataSyncUiStore";
import { useI18n } from "../../i18n";
import { DataSyncPanel } from "./DataSyncPanel";

export function DataSyncWindow() {
  const { t } = useI18n();
  const open = useDataSyncUiStore((s) => s.open);
  const closeDataSync = useDataSyncUiStore((s) => s.closeDataSync);

  return (
    <SubWindow
      open={open}
      title={t("dataSync.title")}
      onClose={closeDataSync}
      className="data-sync-subwindow"
      widthRatio={0.72}
      heightRatio={0.78}
    >
      <DataSyncPanel />
    </SubWindow>
  );
}
