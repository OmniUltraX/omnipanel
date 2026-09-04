import { useCallback, useEffect, useMemo, useState } from "react";

import { FormDialog } from "../../components/ui/form/FormDialog";
import { Select } from "../../components/ui/form/Select";
import { TextInput } from "../../components/ui/form/TextInput";
import { useI18n } from "../../i18n";
import type { Connection } from "../../ipc/bindings";
import { isProdEnvTag } from "../../lib/envTag";
import { parseSshConfig } from "../server/panel/serverConnection";
import {
  findDockerBoundToSsh,
  type DockerImportSshSelection,
  type DockerImportSshSource,
} from "./importDockerFromSsh";

type Props = {
  open: boolean;
  connections: Connection[];
  onClose: () => void;
  /** 用户确认后导入；返回 false 表示取消（弹窗保持打开） */
  onConfirm: (selections: DockerImportSshSelection[]) => boolean | Promise<boolean | void>;
};

const DEFAULT_SOURCE: DockerImportSshSource = "ssh-engine";

function sshSubtitle(conn: Connection): string {
  const cfg = parseSshConfig(conn);
  if (!cfg) return conn.id;
  const port = cfg.port && cfg.port !== 22 ? `:${cfg.port}` : "";
  return `${cfg.user}@${cfg.host}${port}`;
}

function isImportSource(value: string): value is DockerImportSshSource {
  return value === "ssh-engine" || value === "onepanel" || value === "btpanel";
}

/**
 * 从 SSH 导入 Docker：勾选主机并为每台选择连接方式后导入（打开弹窗不探测）。
 */
export function DockerImportFromSshDialog({ open, connections, onClose, onConfirm }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [sources, setSources] = useState<Record<string, DockerImportSshSource>>({});
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const sshList = useMemo(
    () => connections.filter((c) => c.kind === "ssh"),
    [connections],
  );

  const boundSshIds = useMemo(() => {
    const set = new Set<string>();
    for (const ssh of sshList) {
      if (findDockerBoundToSsh(connections, ssh.id)) set.add(ssh.id);
    }
    return set;
  }, [connections, sshList]);

  const sourceOptions = useMemo(
    () => [
      { value: "ssh-engine", label: t("docker.sidebar.importFromSshSourceSshEngine") },
      { value: "onepanel", label: t("docker.sidebar.importFromSshSourceOnePanel") },
      { value: "btpanel", label: t("docker.sidebar.importFromSshSourceBtPanel") },
    ],
    [t],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    setStarting(false);
    const list = connections.filter((c) => c.kind === "ssh");
    const nextSources: Record<string, DockerImportSshSource> = {};
    for (const c of list) {
      nextSources[c.id] = DEFAULT_SOURCE;
    }
    setSources(nextSources);

    // 默认勾选：未绑定且非生产环境
    const preferred = list.filter(
      (c) => !findDockerBoundToSsh(connections, c.id) && !isProdEnvTag(c.envTag),
    );
    const next = new Set<string>();
    for (const c of preferred) next.add(c.id);
    setSelected(next);
  }, [open, connections]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sshList;
    return sshList.filter((c) => {
      const hay = `${c.name} ${sshSubtitle(c)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [query, sshList]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((c) => selected.has(c.id));

  const toggleId = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllFiltered = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const c of filtered) next.delete(c.id);
      } else {
        for (const c of filtered) next.add(c.id);
      }
      return next;
    });
  }, [allFilteredSelected, filtered]);

  const setSourceFor = useCallback((id: string, source: DockerImportSshSource) => {
    setSources((prev) => ({ ...prev, [id]: source }));
  }, []);

  const handleStart = async () => {
    const selections: DockerImportSshSelection[] = [...selected].map((id) => ({
      sshConnectionId: id,
      source: sources[id] ?? DEFAULT_SOURCE,
    }));
    if (selections.length === 0) {
      setError(t("docker.sidebar.importFromSshSelectRequired"));
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const result = await onConfirm(selections);
      if (result === false) return;
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("docker.sidebar.importFromSshTitle")}
      subtitle={t("docker.sidebar.importFromSshSubtitle")}
      size="lg"
      cancelDisabled={starting}
      onCancel={onClose}
      status={error ? { kind: "error", message: error } : null}
      primaryAction={{
        label: t("docker.sidebar.importFromSshAction", { count: String(selected.size) }),
        disabled: starting || selected.size === 0 || sshList.length === 0,
        onClick: () => void handleStart(),
      }}
    >
      <div className="ssh-config-import">
        <TextInput
          size="sm"
          value={query}
          onChange={setQuery}
          placeholder={t("docker.sidebar.importFromSshSearch")}
          disabled={starting}
          copyable={false}
        />
        <div className="ssh-config-import__toolbar">
          <label className="ssh-config-import__check-all">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              disabled={starting || filtered.length === 0}
              onChange={toggleAllFiltered}
            />
            <span>{t("docker.sidebar.importFromSshSelectAll")}</span>
          </label>
          <span className="ssh-config-import__meta">
            {t("docker.sidebar.importFromSshSelected", {
              selected: String(selected.size),
              total: String(sshList.length),
            })}
          </span>
        </div>
        <div className="ssh-config-import__list">
          {filtered.length === 0 ? (
            <div className="ssh-config-import__empty">
              {sshList.length === 0
                ? t("docker.sidebar.importFromSshNoHosts")
                : t("docker.sidebar.importFromSshNoMatch")}
            </div>
          ) : (
            filtered.map((conn) => {
              const bound = boundSshIds.has(conn.id);
              const checked = selected.has(conn.id);
              const source = sources[conn.id] ?? DEFAULT_SOURCE;
              const prod = isProdEnvTag(conn.envTag);
              return (
                <div
                  key={conn.id}
                  className={`ssh-config-import__row ssh-config-import__row--with-source${
                    checked ? " ssh-config-import__row--checked" : ""
                  }`}
                >
                  <label className="ssh-config-import__row-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleId(conn.id)}
                      disabled={starting}
                    />
                    <span className="ssh-config-import__row-body">
                      <span className="ssh-config-import__alias">{conn.name}</span>
                      <span className="ssh-config-import__subtitle">{sshSubtitle(conn)}</span>
                    </span>
                  </label>
                  <div
                    className="ssh-config-import__source"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <Select
                      size="sm"
                      value={source}
                      disabled={starting}
                      options={sourceOptions}
                      aria-label={t("docker.sidebar.importFromSshSource")}
                      onChange={(value) => {
                        if (isImportSource(value)) setSourceFor(conn.id, value);
                      }}
                    />
                  </div>
                  {bound ? (
                    <span className="badge badge-muted">{t("docker.sidebar.importFromSshBound")}</span>
                  ) : null}
                  {prod ? (
                    <span className="badge badge-muted">{t("docker.sidebar.importFromSshProd")}</span>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </FormDialog>
  );
}
