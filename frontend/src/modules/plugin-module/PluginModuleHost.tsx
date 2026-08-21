import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../i18n";
import { getPluginModule } from "../../lib/pluginModuleRegistry";
import { isPluginActivated, usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";

export function PluginModuleHost({ moduleKey }: { moduleKey: string }) {
  const { t } = useI18n();
  usePluginRuntimeStore((s) => s.items);
  const desc = getPluginModule(moduleKey);
  const name = desc ? t(desc.labelI18nKey) : moduleKey;
  const activated = desc ? isPluginActivated(desc.pluginId) : false;
  return (
    <WorkspaceEmptyPage
      title={name}
      prompt={
        activated
          ? t("plugins.moduleShell.hint", { name })
          : t("plugins.moduleShell.disabled", { name })
      }
    />
  );
}
