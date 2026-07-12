import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n";
import type { DockerContainerDetail } from "../../../ipc/bindings";
import { inspectDockerContainer } from "./dockerContainerApi";

interface DockerContainerParamsViewProps {
  connectionId: string;
  containerId: string;
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  const text = value?.trim();
  if (!text) return null;
  return (
    <div className="docker-container-subwindow__info-row">
      <dt>{label}</dt>
      <dd title={text}>{text}</dd>
    </div>
  );
}

function KeyValueTable({
  title,
  rows,
  emptyText,
}: {
  title: string;
  rows: Array<{ key: string; value: string }>;
  emptyText: string;
}) {
  if (rows.length === 0) {
    return (
      <section className="docker-container-subwindow__section">
        <h3 className="docker-container-subwindow__section-title">{title}</h3>
        <p className="docker-container-subwindow__empty">{emptyText}</p>
      </section>
    );
  }
  return (
    <section className="docker-container-subwindow__section">
      <h3 className="docker-container-subwindow__section-title">{title}</h3>
      <div className="docker-container-subwindow__table-wrap">
        <table className="docker-container-subwindow__table">
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.key}:${row.value}`}>
                <th scope="row">{row.key}</th>
                <td title={row.value}>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function DockerContainerParamsView({ connectionId, containerId }: DockerContainerParamsViewProps) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<DockerContainerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void inspectDockerContainer(connectionId, containerId)
      .then((data) => {
        if (!cancelled) {
          setDetail(data);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setDetail(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, containerId]);

  if (loading) {
    return <div className="docker-container-subwindow__state">{t("docker.dockPanel.subwindowLoading")}</div>;
  }
  if (error) {
    return <div className="docker-container-subwindow__error">{error}</div>;
  }
  if (!detail) {
    return <div className="docker-container-subwindow__state">{t("docker.dockPanel.subwindowEmpty")}</div>;
  }

  const { summary } = detail;
  const mountRows = detail.mounts.map((mount) => ({
    key: mount.destination,
    value: [mount.kind, mount.source, mount.readOnly ? "ro" : "rw"].filter(Boolean).join(" · "),
  }));
  const networkRows = detail.networks.map((network) => ({
    key: network.name,
    value: network.ipAddress ?? "—",
  }));

  return (
    <div className="docker-container-subwindow docker-container-subwindow--params">
      <section className="docker-container-subwindow__section">
        <h3 className="docker-container-subwindow__section-title">{t("docker.dockPanel.subwindowBasicInfo")}</h3>
        <dl className="docker-container-subwindow__info-grid">
          <InfoRow label={t("docker.dockPanel.subwindowFieldId")} value={summary.id} />
          <InfoRow label={t("docker.dockPanel.subwindowFieldImage")} value={summary.image} />
          <InfoRow label={t("docker.dockPanel.subwindowFieldState")} value={summary.statusText || summary.state} />
          <InfoRow label={t("docker.dockPanel.subwindowFieldCommand")} value={detail.command} />
          <InfoRow label={t("docker.dockPanel.subwindowFieldRestart")} value={detail.restartPolicy} />
          <InfoRow
            label={t("docker.dockPanel.subwindowFieldExitCode")}
            value={detail.exitCode != null ? String(detail.exitCode) : null}
          />
        </dl>
      </section>

      <KeyValueTable
        title={t("docker.dockPanel.subwindowEnv")}
        rows={detail.env.map((item) => ({ key: item.key, value: item.value }))}
        emptyText={t("docker.dockPanel.subwindowEmpty")}
      />
      <KeyValueTable
        title={t("docker.dockPanel.subwindowMounts")}
        rows={mountRows}
        emptyText={t("docker.dockPanel.subwindowEmpty")}
      />
      <KeyValueTable
        title={t("docker.dockPanel.subwindowNetworks")}
        rows={networkRows}
        emptyText={t("docker.dockPanel.subwindowEmpty")}
      />
    </div>
  );
}
