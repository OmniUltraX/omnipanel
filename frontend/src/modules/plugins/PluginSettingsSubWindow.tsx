import { useCallback, useEffect, useMemo, useState } from "react";
import { SubWindow } from "../../components/ui/window/SubWindow";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { useI18n } from "../../i18n";
import { formatIpcError } from "../../ipc/result";
import {
  loadPluginConfigurationValues,
  resolvePluginConfiguration,
  savePluginConfigurationValues,
  type ResolvedPluginConfiguration,
} from "../../lib/pluginConfiguration";
import { pluginDisplayName } from "./pluginDisplayName";
import { PluginSettingsForm } from "./PluginSettingsForm";
import {
  isKnownPluginSettingsPanel,
  renderPluginSettingsPanel,
  type PluginSettingsPanelActions,
} from "./pluginSettingsPanels";

type Props = {
  open: boolean;
  pluginId: string | null;
  onClose: () => void;
};

export function PluginSettingsSubWindow({ open, pluginId, onClose }: Props) {
  const { t } = useI18n();
  const resolved = useMemo(
    () => (pluginId ? resolvePluginConfiguration(pluginId) : null),
    [pluginId],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState(false);
  const [panelActions, setPanelActions] = useState<PluginSettingsPanelActions | null>(null);

  const onPanelActionsChange = useCallback((actions: PluginSettingsPanelActions | null) => {
    setPanelActions(actions);
  }, []);

  const title = useMemo(() => {
    if (!pluginId) return t("plugins.settings.title");
    const name = pluginDisplayName(pluginId, t);
    const section = resolved?.title?.trim();
    // configuration.title 常与插件显示名相同（如 Warpgate），避免「Warpgate · Warpgate」
    if (section && section.toLowerCase() !== name.toLowerCase()) {
      return t("plugins.settings.titleNamed", { name, section });
    }
    return t("plugins.settings.titleNamedSimple", { name });
  }, [pluginId, resolved?.title, t]);

  const reload = useCallback(
    async (id: string, config: ResolvedPluginConfiguration) => {
      setError(null);
      setSavedHint(false);
      try {
        setValues(await loadPluginConfigurationValues(id, config));
      } catch (err) {
        setError(formatIpcError(err));
        setValues({});
      }
    },
    [],
  );

  useEffect(() => {
    if (!open || !pluginId || !resolved) return;
    void reload(pluginId, resolved);
  }, [open, pluginId, resolved, reload]);

  useEffect(() => {
    if (!open) setPanelActions(null);
  }, [open, pluginId]);

  const handleSaveFields = async () => {
    if (!pluginId || !resolved) return;
    setBusy(true);
    setError(null);
    setSavedHint(false);
    try {
      await savePluginConfigurationValues(pluginId, resolved, values);
      setSavedHint(true);
    } catch (err) {
      setError(formatIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const panelNode =
    pluginId && resolved?.panel
      ? renderPluginSettingsPanel(resolved.panel, pluginId, {
          onActionsChange: onPanelActionsChange,
        })
      : null;
  const unknownPanel =
    Boolean(resolved?.panel) && !isKnownPluginSettingsPanel(resolved?.panel);
  const hasFields = (resolved?.fields.length ?? 0) > 0;
  const showSave = hasFields || Boolean(panelActions);

  return (
    <SubWindow
      open={open && Boolean(pluginId)}
      title={title}
      onClose={onClose}
      widthRatio={0.48}
      heightRatio={0.72}
      className="plugin-settings-subwindow"
    >
      <div className="plugin-settings-subwindow__body">
        {!resolved ? (
          <p className="form-hint">{t("plugins.settings.empty")}</p>
        ) : (
          <>
            {error ? (
              <p className="form-hint" style={{ color: "var(--danger, #c44)" }}>
                {error}
              </p>
            ) : null}
            {unknownPanel ? (
              <p className="form-hint">
                {t("plugins.settings.unknownPanel", { id: resolved.panel ?? "" })}
              </p>
            ) : null}
            {panelNode}
            {hasFields ? (
              <>
                {panelNode ? (
                  <div className="form-section-title" style={{ marginTop: 16 }}>
                    {t("plugins.settings.fieldsSection")}
                  </div>
                ) : null}
                <PluginSettingsForm
                  fields={resolved.fields}
                  values={values}
                  disabled={busy}
                  onChange={(key, value) =>
                    setValues((prev) => ({ ...prev, [key]: value }))
                  }
                />
              </>
            ) : null}
            {!panelNode && !hasFields ? (
              <p className="form-hint">{t("plugins.settings.empty")}</p>
            ) : null}
          </>
        )}
      </div>
      {showSave ? (
        <div className="plugin-settings-subwindow__footer">
          {panelActions?.onSecondary ? (
            <WorkbenchActionButton
              disabled={panelActions.busy || panelActions.disabled}
              onClick={panelActions.onSecondary}
            >
              {panelActions.secondaryLabel}
            </WorkbenchActionButton>
          ) : savedHint ? (
            <span className="form-hint" style={{ margin: 0 }}>
              {t("plugins.settings.saved")}
            </span>
          ) : (
            <span />
          )}
          {panelActions ? (
            <WorkbenchActionButton
              disabled={panelActions.busy || panelActions.disabled}
              onClick={panelActions.onPrimary}
            >
              {panelActions.busy ? t("common.saving") : panelActions.primaryLabel}
            </WorkbenchActionButton>
          ) : (
            <WorkbenchActionButton disabled={busy || !resolved} onClick={() => void handleSaveFields()}>
              {busy ? t("common.saving") : t("common.save")}
            </WorkbenchActionButton>
          )}
        </div>
      ) : null}
    </SubWindow>
  );
}
