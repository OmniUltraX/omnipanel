import { FormDialog } from "../form/FormDialog";
import { useI18n } from "../../../i18n";
import { usePluginOverlayStore } from "../../../stores/pluginOverlayStore";

/** 插件 Overlay 总线宿主：addon 不得自建 WebView。 */
export function PluginOverlayHost() {
  const { t } = useI18n();
  const entries = usePluginOverlayStore((s) => s.entries);
  const hide = usePluginOverlayStore((s) => s.hide);
  const top = entries[entries.length - 1];
  if (!top) return null;
  return (
    <FormDialog
      open
      title={top.title}
      onClose={() => hide(top.id)}
      primaryAction={{ label: t("common.close"), onClick: () => hide(top.id) }}
    >
      <pre className="setting-hint" style={{ whiteSpace: "pre-wrap" }}>
        {top.body}
      </pre>
    </FormDialog>
  );
}
