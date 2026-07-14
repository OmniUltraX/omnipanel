import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { CodeEditor } from "../../components/ui/content/CodeEditor";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import { showToast } from "../../stores/toastStore";
import {
  readDockerDaemonConfig,
  writeDockerDaemonConfig,
} from "./dockerDaemonConfigApi";

export interface DockerDaemonConfigTabPanelProps {
  connection: DockerConnectionInfo;
  isActive: boolean;
}

export function DockerDaemonConfigTabPanel({
  connection,
}: DockerDaemonConfigTabPanelProps) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [editable, setEditable] = useState(true);
  const [saving, setSaving] = useState(false);
  /** 已成功加载过配置的连接 id；切回当前页签时复用缓存 */
  const loadedConnectionIdRef = useRef<string | null>(null);

  const loadConfig = useCallback(async (force = false) => {
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
      loadedConnectionIdRef.current = connectionId;
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connection.connectionId]);

  useEffect(() => {
    // 连接切换或 dock 面板重挂载时加载；子页签切换不触发
    loadedConnectionIdRef.current = null;
    void loadConfig(true);
  }, [connection.connectionId, loadConfig]);

  const dirty = content !== savedContent;

  const handleSave = () => {
    void (async () => {
      setSaving(true);
      try {
        await writeDockerDaemonConfig(connection.connectionId, content);
        setSavedContent(content);
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
          <span>{t("docker.connectionPanel.configTitle")}</span>
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
      <div className="docker-daemon-config-tab__editor">
        <CodeEditor
          value={content}
          onChange={setContent}
          language="json"
          readOnly={!editable}
          height="100%"
          className="docker-daemon-config-tab__code"
        />
      </div>
    </div>
  );
}
