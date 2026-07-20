import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { CodeEditor } from "../../components/ui/content/CodeEditor";
import { FormField } from "../../components/ui/form/FormField";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import { showToast } from "../../stores/toastStore";
import {
  readDockerDaemonConfig,
  writeDockerDaemonConfig,
} from "./dockerDaemonConfigApi";
import {
  DEFAULT_DOCKER_DAEMON_FORM,
  type DockerCgroupDriver,
  type DockerDaemonFormState,
  mergeFormIntoDaemonConfig,
  tryParseDaemonConfigToForm,
} from "./dockerDaemonConfigForm";

export interface DockerDaemonConfigTabPanelProps {
  connection: DockerConnectionInfo;
  isActive: boolean;
}

type ConfigViewMode = "form" | "source";

function ToggleSwitch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`toggle${checked ? " on" : ""}${disabled ? " toggle--disabled" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function DockerDaemonConfigTabPanel({
  connection,
}: DockerDaemonConfigTabPanelProps) {
  const { t } = useI18n();
  const mirrorsId = useId();
  const registriesId = useId();
  const socketId = useId();
  const logMaxSizeId = useId();
  const logMaxFileId = useId();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [form, setForm] = useState<DockerDaemonFormState>(DEFAULT_DOCKER_DAEMON_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ConfigViewMode>("form");
  const [editable, setEditable] = useState(true);
  const [saving, setSaving] = useState(false);
  /** 已成功加载过配置的连接 id；切回当前页签时复用缓存 */
  const loadedConnectionIdRef = useRef<string | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  const syncFormFromContent = useCallback((nextContent: string) => {
    const parsed = tryParseDaemonConfigToForm(nextContent);
    if (parsed.ok) {
      setForm(parsed.form);
      setFormError(null);
      return true;
    }
    setFormError(parsed.error);
    return false;
  }, []);

  const loadConfig = useCallback(
    async (force = false) => {
      const connectionId = connection.connectionId;
      if (!force && loadedConnectionIdRef.current === connectionId) {
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const file = await readDockerDaemonConfig(connectionId);
        setConfigPath(file.path);
        setContent(file.content);
        setSavedContent(file.content);
        setEditable(file.editable);
        const ok = syncFormFromContent(file.content);
        if (!ok) {
          setViewMode("source");
        }
        loadedConnectionIdRef.current = connectionId;
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [connection.connectionId, syncFormFromContent],
  );

  useEffect(() => {
    // 连接切换或 dock 面板重挂载时加载；子页签切换不触发
    loadedConnectionIdRef.current = null;
    setViewMode("form");
    void loadConfig(true);
  }, [connection.connectionId, loadConfig]);

  const dirty = content !== savedContent;

  const applyFormPatch = useCallback((patch: Partial<DockerDaemonFormState>) => {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      try {
        const merged = mergeFormIntoDaemonConfig(contentRef.current, next);
        contentRef.current = merged;
        setContent(merged);
        setFormError(null);
      } catch (e) {
        setFormError(e instanceof Error ? e.message : String(e));
      }
      return next;
    });
  }, []);


  const handleViewModeChange = (mode: ConfigViewMode) => {
    if (mode === viewMode) return;
    if (mode === "form") {
      if (!syncFormFromContent(content)) {
        showToast(t("docker.connectionPanel.configFormParseFailed"));
        return;
      }
    }
    setViewMode(mode);
  };

  const handleSourceChange = (next: string) => {
    setContent(next);
  };

  const handleSave = () => {
    void (async () => {
      let toSave = content;
      if (viewMode === "form") {
        try {
          toSave = mergeFormIntoDaemonConfig(content, form);
          setContent(toSave);
        } catch (e) {
          showToast(
            `${t("docker.connectionPanel.configSaveFailed")}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          return;
        }
      } else {
        try {
          JSON.parse(toSave.trim() || "{}");
        } catch (e) {
          showToast(
            `${t("docker.connectionPanel.configInvalidJson")}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          return;
        }
      }

      setSaving(true);
      try {
        await writeDockerDaemonConfig(connection.connectionId, toSave);
        setSavedContent(toSave);
        syncFormFromContent(toSave);
        showToast(t("docker.connectionPanel.configSaved"));
      } catch (e) {
        showToast(
          `${t("docker.connectionPanel.configSaveFailed")}: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        setSaving(false);
      }
    })();
  };

  if (loading && !content) {
    return <div className="docker-connection-info-empty">{t("docker.connectionPanel.configLoading")}</div>;
  }

  if (error) {
    return <div className="docker-connection-info-error">{error}</div>;
  }

  if (!editable) {
    return (
      <div className="docker-connection-info-empty">
        {t("docker.connectionPanel.configUnsupported")}
      </div>
    );
  }

  return (
    <div className="docker-daemon-config-tab">
      <div className="docker-daemon-config-tab__header">
        <div className="docker-daemon-config-tab__title">
          <div className="docker-daemon-config-tab__modes" role="tablist">
            <button
              type="button"
              role="tab"
              className={`docker-daemon-config-tab__mode${viewMode === "form" ? " active" : ""}`}
              aria-selected={viewMode === "form"}
              onClick={() => handleViewModeChange("form")}
            >
              {t("docker.connectionPanel.configModeForm")}
            </button>
            <button
              type="button"
              role="tab"
              className={`docker-daemon-config-tab__mode${viewMode === "source" ? " active" : ""}`}
              aria-selected={viewMode === "source"}
              onClick={() => handleViewModeChange("source")}
            >
              {t("docker.connectionPanel.configModeSource")}
            </button>
          </div>
          {configPath ? (
            <span className="docker-daemon-config-tab__path" title={configPath}>
              {configPath}
            </span>
          ) : null}
        </div>
        <Button size="sm" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? t("docker.connectionPanel.configSaving") : t("docker.connectionPanel.configSave")}
        </Button>
      </div>

      {viewMode === "form" ? (
        <div className="docker-daemon-config-tab__form">
          {formError ? (
            <div className="docker-daemon-config-tab__form-error">
              {t("docker.connectionPanel.configFormParseFailed")}: {formError}
            </div>
          ) : null}

          <FormField
            layout="horizontal"
            htmlFor={mirrorsId}
            label={t("docker.connectionPanel.configRegistryMirrors")}
            hint={t("docker.connectionPanel.configRegistryMirrorsHint")}
          >
            <textarea
              id={mirrorsId}
              className="docker-daemon-config-tab__textarea"
              rows={4}
              value={form.registryMirrors}
              disabled={Boolean(formError)}
              placeholder={t("docker.connectionPanel.configRegistryMirrorsPlaceholder")}
              onChange={(e) => applyFormPatch({ registryMirrors: e.target.value })}
            />
          </FormField>

          <FormField
            layout="horizontal"
            htmlFor={registriesId}
            label={t("docker.connectionPanel.configInsecureRegistries")}
            hint={t("docker.connectionPanel.configInsecureRegistriesHint")}
          >
            <textarea
              id={registriesId}
              className="docker-daemon-config-tab__textarea"
              rows={3}
              value={form.insecureRegistries}
              disabled={Boolean(formError)}
              placeholder={t("docker.connectionPanel.configNotSet")}
              onChange={(e) => applyFormPatch({ insecureRegistries: e.target.value })}
            />
          </FormField>

          <FormField layout="horizontal" label={t("docker.connectionPanel.configIpv6")}>
            <ToggleSwitch
              checked={form.ipv6}
              disabled={Boolean(formError)}
              label={t("docker.connectionPanel.configIpv6")}
              onChange={(ipv6) => applyFormPatch({ ipv6 })}
            />
          </FormField>

          <FormField
            layout="horizontal"
            label={t("docker.connectionPanel.configLogRotation")}
            hint={
              form.logRotation ? t("docker.connectionPanel.configLogRotationHint") : undefined
            }
          >
            <div className="docker-daemon-config-tab__log-rotation">
              <ToggleSwitch
                checked={form.logRotation}
                disabled={Boolean(formError)}
                label={t("docker.connectionPanel.configLogRotation")}
                onChange={(logRotation) => applyFormPatch({ logRotation })}
              />
              {form.logRotation ? (
                <div className="docker-daemon-config-tab__log-opts">
                  <label className="docker-daemon-config-tab__inline-field" htmlFor={logMaxSizeId}>
                    <span>{t("docker.connectionPanel.configLogMaxSize")}</span>
                    <input
                      id={logMaxSizeId}
                      type="text"
                      value={form.logMaxSize}
                      disabled={Boolean(formError)}
                      onChange={(e) => applyFormPatch({ logMaxSize: e.target.value })}
                    />
                  </label>
                  <label className="docker-daemon-config-tab__inline-field" htmlFor={logMaxFileId}>
                    <span>{t("docker.connectionPanel.configLogMaxFile")}</span>
                    <input
                      id={logMaxFileId}
                      type="text"
                      value={form.logMaxFile}
                      disabled={Boolean(formError)}
                      onChange={(e) => applyFormPatch({ logMaxFile: e.target.value })}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          </FormField>

          <FormField
            layout="horizontal"
            label="iptables"
            description={t("docker.connectionPanel.configIptablesHint")}
          >
            <ToggleSwitch
              checked={form.iptables}
              disabled={Boolean(formError)}
              label="iptables"
              onChange={(iptables) => applyFormPatch({ iptables })}
            />
          </FormField>

          <FormField
            layout="horizontal"
            label="Live restore"
            description={t("docker.connectionPanel.configLiveRestoreHint")}
          >
            <ToggleSwitch
              checked={form.liveRestore}
              disabled={Boolean(formError)}
              label="Live restore"
              onChange={(liveRestore) => applyFormPatch({ liveRestore })}
            />
          </FormField>

          <FormField layout="horizontal" label="Cgroup Driver">
            <div className="docker-daemon-config-tab__radios" role="radiogroup">
              {(["cgroupfs", "systemd"] as const).map((driver) => (
                <label key={driver} className="docker-daemon-config-tab__radio">
                  <input
                    type="radio"
                    name="docker-cgroup-driver"
                    value={driver}
                    checked={form.cgroupDriver === driver}
                    disabled={Boolean(formError)}
                    onChange={() =>
                      applyFormPatch({ cgroupDriver: driver as DockerCgroupDriver })
                    }
                  />
                  <span>{driver}</span>
                </label>
              ))}
            </div>
          </FormField>

          <FormField
            layout="horizontal"
            htmlFor={socketId}
            label={t("docker.connectionPanel.configSocketPath")}
            hint={t("docker.connectionPanel.configSocketPathHint")}
          >
            <textarea
              id={socketId}
              className="docker-daemon-config-tab__textarea docker-daemon-config-tab__textarea--single"
              rows={2}
              value={form.socketPath}
              disabled={Boolean(formError)}
              placeholder="unix:///var/run/docker.sock"
              onChange={(e) => applyFormPatch({ socketPath: e.target.value })}
            />
          </FormField>
        </div>
      ) : (
        <div className="docker-daemon-config-tab__editor">
          <CodeEditor
            value={content}
            onChange={handleSourceChange}
            language="json"
            readOnly={!editable}
            height="100%"
            className="docker-daemon-config-tab__code"
          />
        </div>
      )}
    </div>
  );
}
