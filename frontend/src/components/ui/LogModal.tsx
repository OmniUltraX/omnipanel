import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import { LogViewer } from "./LogViewer";
import { SubWindow } from "./SubWindow";
import { Select } from "./Select";

type LogEntry = {
  timestamp: string;
  module: string;
  level: string;
  message: string;
};

interface LogModalProps {
  open: boolean;
  onClose: () => void;
}

const LEVEL_ORDER = ["error", "warn", "info"] as const;

const LEVEL_ANSI: Record<string, string> = {
  error: "\x1b[31m",
  warn: "\x1b[33m",
  info: "\x1b[36m",
};

const ANSI_RESET = "\x1b[0m";

function formatLogText(entries: LogEntry[]): string {
  return entries
    .map((entry) => {
      const color = LEVEL_ANSI[entry.level] ?? "";
      return `${entry.timestamp}\t${color}${entry.level.toUpperCase()}${ANSI_RESET}\t${entry.module}\t${entry.message}`;
    })
    .join("\n");
}

export function LogModal({ open, onClose }: LogModalProps) {
  const { t } = useI18n();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filterModule, setFilterModule] = useState<string | null>(null);
  const [filterLevel, setFilterLevel] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const data = await invoke<LogEntry[]>("get_backend_logs");
      setLogs(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    fetchLogs();
    const timer = setInterval(fetchLogs, 3000);
    return () => clearInterval(timer);
  }, [open, fetchLogs]);

  const handleClear = useCallback(async () => {
    await invoke("clear_backend_logs");
    setLogs([]);
  }, []);

  const modules = useMemo(() => [...new Set(logs.map((l) => l.module))].sort(), [logs]);

  const filtered = useMemo(
    () =>
      logs.filter((l) => {
        if (filterModule && l.module !== filterModule) return false;
        if (filterLevel && l.level !== filterLevel) return false;
        return true;
      }),
    [logs, filterModule, filterLevel],
  );

  const logText = useMemo(() => formatLogText(filtered), [filtered]);

  return (
    <SubWindow
      open={open}
      title={t("shell.statusbar.backendLogs")}
      onClose={onClose}
      className="log-subwindow"
    >
      <LogViewer
        text={logText}
        emptyText={t("logViewer.empty")}
        onClear={handleClear}
        footer={<span className="log-viewer-panel__footer-text">{t("logViewer.lineCount", { count: filtered.length })}</span>}
        toolbar={
          <>
            <Select
              className="log-viewer-panel__select"
              value={filterModule ?? ""}
              onChange={(v) => setFilterModule(v || null)}
              searchable={modules.length >= 8}
              options={[
                { value: "", label: "全部模块" },
                ...modules.map((m) => ({ value: m, label: m })),
              ]}
            />
            <Select
              className="log-viewer-panel__select"
              value={filterLevel ?? ""}
              onChange={(v) => setFilterLevel(v || null)}
              searchable={false}
              options={[
                { value: "", label: "全部级别" },
                ...LEVEL_ORDER.map((l) => ({ value: l, label: l.toUpperCase() })),
              ]}
            />
          </>
        }
      />
    </SubWindow>
  );
}
