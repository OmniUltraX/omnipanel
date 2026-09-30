import { useCallback, useEffect, useMemo, useState } from "react";
import { FormDialog } from "../../../../components/ui/form/FormDialog";
import { Select } from "../../../../components/ui/form/Select";
import { TextInput } from "../../../../components/ui/form/TextInput";
import { WorkbenchActionButton } from "../../../../components/ui/primitives/WorkbenchActionButton";
import { useI18n } from "../../../../i18n";
import { formatIpcError } from "../../../../ipc/result";
import { useConnectionStore } from "../../../../stores/connectionStore";
import {
  importWarpgateSshPicks,
  loadWarpgateImportRows,
  type WarpgateImportPick,
  type WarpgateImportResult,
  type WarpgateImportRow,
} from "../importWarpgateSsh";
import { WarpgateGatewaysDialog } from "./WarpgateGatewaysDialog";
import { showToast } from "../../../../stores/toastStore";

type Props = {
  open: boolean;
  onClose: () => void;
  /** 导入成功后回调（可用于把新主机放进文件夹） */
  onImported?: (result: WarpgateImportResult) => void | Promise<void>;
};

/**
 * 从已配置的 Warpgate 网关拉取 SSH Target，勾选后导入为本机 SSH 连接。
 */
export function WarpgateSshImportDialog({ open, onClose, onImported }: Props) {
  const { t } = useI18n();
  const connections = useConnectionStore((s) => s.connections);
  const [rows, setRows] = useState<WarpgateImportRow[]>([]);
  const [gatewayFilter, setGatewayFilter] = useState<string>("all");
  const [gatewayOptions, setGatewayOptions] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [manageOpen, setManageOpen] = useState(false);

  const existingNames = useMemo(() => {
    const set = new Set<string>();
    for (const c of connections) {
      if (c.kind === "ssh") set.add(c.name);
    }
    return set;
  }, [connections]);

  const reload = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const { rows: nextRows, gateways } = await loadWarpgateImportRows({ force });
      setRows(nextRows);
      setGatewayOptions([
        { value: "all", label: t("ssh.warpgate.importAllGateways") },
        ...gateways.map((g) => ({
          value: g.id,
          label: g.name.trim() || g.baseUrl,
        })),
      ]);
      setGatewayFilter((prev) =>
        prev !== "all" && !gateways.some((g) => g.id === prev) ? "all" : prev,
      );
      const names = new Set(
        useConnectionStore
          .getState()
          .connections.filter((c) => c.kind === "ssh")
          .map((c) => c.name),
      );
      const next = new Set<string>();
      for (const row of nextRows) {
        if (!names.has(row.target.name)) next.add(row.key);
      }
      if (next.size === 0) {
        for (const row of nextRows) next.add(row.key);
      }
      setSelected(next);
    } catch (e) {
      setRows([]);
      setSelected(new Set());
      setError(e instanceof Error ? e.message : formatIpcError(e));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    setImporting(false);
    setManageOpen(false);
    void reload(true);
    // 仅在打开时拉取；刷新按钮走 reload(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open 边沿
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (gatewayFilter !== "all" && row.gateway.id !== gatewayFilter) return false;
      if (!q) return true;
      const hay = `${row.target.name} ${row.target.id} ${row.gateway.name} ${row.gateway.baseUrl} ${row.target.bastionHost}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query, gatewayFilter]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((row) => selected.has(row.key));

  const toggleKey = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAllFiltered = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const row of filtered) next.delete(row.key);
      } else {
        for (const row of filtered) next.add(row.key);
      }
      return next;
    });
  }, [allFilteredSelected, filtered]);

  const handleImport = async () => {
    const picks: WarpgateImportPick[] = [];
    for (const row of rows) {
      if (!selected.has(row.key)) continue;
      picks.push({
        gatewayId: row.gateway.id,
        targetId: row.target.id,
        targetName: row.target.name,
      });
    }
    if (picks.length === 0) {
      setError(t("ssh.warpgate.importSelectRequired"));
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const result = await importWarpgateSshPicks(picks);
      if (result.failures.length > 0 && result.added === 0 && result.updated === 0) {
        setError(result.failures.slice(0, 3).join("；"));
        return;
      }
      showToast(
        t("ssh.sidebar.syncResult", {
          added: String(result.added),
          updated: String(result.updated),
          skipped: String(result.skipped),
        }),
      );
      if (result.failures.length > 0) {
        showToast(
          t("ssh.sidebar.syncFailures", { count: String(result.failures.length) }),
        );
      }
      await onImported?.(result);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : formatIpcError(e));
    } finally {
      setImporting(false);
    }
  };

  const emptyHint =
    gatewayOptions.length <= 1
      ? t("ssh.warpgate.importNoGateways")
      : t("ssh.warpgate.importEmpty");

  return (
    <>
      <FormDialog
        open={open}
        onClose={onClose}
        title={t("ssh.warpgate.importTitle")}
        subtitle={t("ssh.warpgate.importSubtitle")}
        size="md"
        cancelDisabled={importing}
        onCancel={onClose}
        status={error ? { kind: "error", message: error } : null}
        primaryAction={{
          label: importing
            ? t("ssh.warpgate.importImporting")
            : t("ssh.warpgate.importAction", { count: String(selected.size) }),
          disabled: importing || loading || selected.size === 0,
          onClick: () => void handleImport(),
        }}
      >
        <div className="ssh-config-import">
          <div className="ssh-config-import__toolbar" style={{ marginBottom: 8, gap: 8 }}>
            <Select
              value={gatewayFilter}
              onChange={setGatewayFilter}
              options={gatewayOptions}
              disabled={loading || gatewayOptions.length <= 1}
              style={{ flex: 1, minWidth: 0 }}
            />
            <WorkbenchActionButton
              disabled={loading || importing}
              onClick={() => void reload(true)}
            >
              {t("common.refresh")}
            </WorkbenchActionButton>
            <WorkbenchActionButton
              disabled={importing}
              onClick={() => setManageOpen(true)}
            >
              {t("ssh.warpgate.manageGateways")}
            </WorkbenchActionButton>
          </div>
          <TextInput
            size="sm"
            value={query}
            onChange={setQuery}
            placeholder={t("ssh.warpgate.importSearch")}
            disabled={loading}
            copyable={false}
          />
          <div className="ssh-config-import__toolbar">
            <label className="ssh-config-import__check-all">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                disabled={loading || filtered.length === 0}
                onChange={toggleAllFiltered}
              />
              <span>{t("ssh.sidebar.importConfigSelectAll")}</span>
            </label>
            <span className="ssh-config-import__meta">
              {t("ssh.sidebar.importConfigSelected", {
                selected: String(selected.size),
                total: String(rows.length),
              })}
            </span>
          </div>
          <div className="ssh-config-import__list">
            {loading ? (
              <div className="ssh-config-import__empty">{t("ssh.warpgate.importLoading")}</div>
            ) : filtered.length === 0 ? (
              <div className="ssh-config-import__empty">
                {rows.length === 0 ? emptyHint : t("ssh.sidebar.importConfigNoMatch")}
              </div>
            ) : (
              filtered.map((row) => {
                const exists = existingNames.has(row.target.name);
                const checked = selected.has(row.key);
                const gwLabel = row.gateway.name.trim() || row.gateway.baseUrl;
                const user = row.target.loginUser?.trim() || "—";
                const host = row.target.bastionHost || "—";
                const port =
                  row.target.bastionPort && row.target.bastionPort !== 22
                    ? `:${row.target.bastionPort}`
                    : "";
                return (
                  <label
                    key={row.key}
                    className={`ssh-config-import__row${checked ? " ssh-config-import__row--checked" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleKey(row.key)}
                      disabled={importing}
                    />
                    <span className="ssh-config-import__row-body">
                      <span className="ssh-config-import__alias">{row.target.name}</span>
                      <span className="ssh-config-import__subtitle">
                        {gwLabel} · {user}@{host}{port}
                      </span>
                    </span>
                    {exists ? (
                      <span className="badge badge-muted">{t("ssh.sidebar.importConfigExists")}</span>
                    ) : null}
                  </label>
                );
              })
            )}
          </div>
        </div>
      </FormDialog>
      <WarpgateGatewaysDialog
        open={manageOpen}
        onClose={() => {
          setManageOpen(false);
          void reload(true);
        }}
        onChanged={() => void reload(true)}
      />
    </>
  );
}
