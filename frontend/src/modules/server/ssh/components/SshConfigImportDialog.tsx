import { useCallback, useEffect, useMemo, useState } from "react";
import { FormDialog } from "../../../../components/ui/form/FormDialog";
import { TextInput } from "../../../../components/ui/form/TextInput";
import { useI18n } from "../../../../i18n";
import { commands, type SshConfigEntry } from "../../../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../../../ipc/result";
import { useConnectionStore } from "../../../../stores/connectionStore";

type Props = {
  open: boolean;
  onClose: () => void;
  /** 用户确认导入的 Host 别名列表 */
  onConfirm: (aliases: string[]) => void | Promise<void>;
};

function entrySubtitle(entry: SshConfigEntry): string {
  const user = entry.user?.trim() || "root";
  const host = entry.hostName.trim() || entry.alias;
  const port = entry.port && entry.port !== 22 ? `:${entry.port}` : "";
  return `${user}@${host}${port}`;
}

/**
 * 从 ~/.ssh/config 导入：列出 Host，勾选后导入选中项。
 */
export function SshConfigImportDialog({ open, onClose, onConfirm }: Props) {
  const { t } = useI18n();
  const connections = useConnectionStore((s) => s.connections);
  const [entries, setEntries] = useState<SshConfigEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const existingNames = useMemo(() => {
    const set = new Set<string>();
    for (const c of connections) {
      if (c.kind === "ssh") set.add(c.name);
    }
    return set;
  }, [connections]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    setImporting(false);
    setLoading(true);
    void (async () => {
      try {
        const list = await unwrapCommand(commands.sshListConfigHosts());
        setEntries(list);
        const names = new Set(
          useConnectionStore
            .getState()
            .connections.filter((c) => c.kind === "ssh")
            .map((c) => c.name),
        );
        const next = new Set<string>();
        for (const e of list) {
          if (!names.has(e.alias)) next.add(e.alias);
        }
        if (next.size === 0) {
          for (const e of list) next.add(e.alias);
        }
        setSelected(next);
      } catch (e) {
        setEntries([]);
        setSelected(new Set());
        setError(e instanceof Error ? e.message : formatIpcError(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => {
      const hay = `${e.alias} ${e.hostName} ${e.user ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [entries, query]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((e) => selected.has(e.alias));

  const toggleAlias = useCallback((alias: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  }, []);

  const toggleAllFiltered = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const e of filtered) next.delete(e.alias);
      } else {
        for (const e of filtered) next.add(e.alias);
      }
      return next;
    });
  }, [allFilteredSelected, filtered]);

  const handleImport = async () => {
    const aliases = [...selected];
    if (aliases.length === 0) {
      setError(t("ssh.sidebar.importConfigSelectRequired"));
      return;
    }
    setImporting(true);
    setError(null);
    try {
      await onConfirm(aliases);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : formatIpcError(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("ssh.sidebar.importConfigTitle")}
      subtitle={t("ssh.sidebar.importConfigSubtitle")}
      size="md"
      cancelDisabled={importing}
      onCancel={onClose}
      status={error ? { kind: "error", message: error } : null}
      primaryAction={{
        label: importing
          ? t("ssh.sidebar.importConfigImporting")
          : t("ssh.sidebar.importConfigAction", { count: String(selected.size) }),
        disabled: importing || loading || selected.size === 0,
        onClick: () => void handleImport(),
      }}
    >
      <div className="ssh-config-import">
        <TextInput
          size="sm"
          value={query}
          onChange={setQuery}
          placeholder={t("ssh.sidebar.importConfigSearch")}
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
              total: String(entries.length),
            })}
          </span>
        </div>
        <div className="ssh-config-import__list">
          {loading ? (
            <div className="ssh-config-import__empty">{t("ssh.sidebar.importConfigLoading")}</div>
          ) : filtered.length === 0 ? (
            <div className="ssh-config-import__empty">
              {entries.length === 0
                ? t("ssh.sidebar.importConfigEmpty")
                : t("ssh.sidebar.importConfigNoMatch")}
            </div>
          ) : (
            filtered.map((entry) => {
              const exists = existingNames.has(entry.alias);
              const checked = selected.has(entry.alias);
              return (
                <label
                  key={entry.alias}
                  className={`ssh-config-import__row${checked ? " ssh-config-import__row--checked" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleAlias(entry.alias)}
                    disabled={importing}
                  />
                  <span className="ssh-config-import__row-body">
                    <span className="ssh-config-import__alias">{entry.alias}</span>
                    <span className="ssh-config-import__subtitle">{entrySubtitle(entry)}</span>
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
  );
}
