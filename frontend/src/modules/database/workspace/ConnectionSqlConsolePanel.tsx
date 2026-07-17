import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { commands, type DbQueryResult } from "../../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../../ipc/result";
import { useI18n } from "../../../i18n";
import type { DbConnectionConfig } from "../api";
import { isQueryCancelledError, makeQueryRunId } from "../sql/queryRun";
import {
  loadCliReplSession,
  saveCliReplSession,
} from "./connectionCliReplStore";

const RESULT_ROW_LIMIT = 500;
const HISTORY_LIMIT = 100;

interface ConnectionSqlConsolePanelProps {
  connection: DbConnectionConfig;
  /** 连接信息面板是否激活（仅影响焦点，不卸载会话）。 */
  panelActive: boolean;
  /** 命令行子标签是否可见（仅控制展示，不断开会话）。 */
  visible: boolean;
}

function cellText(value: unknown): string {
  if (value == null) {
    return "NULL";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 仿 mysql 客户端 ASCII 表输出。 */
export function formatMysqlAsciiTable(result: DbQueryResult): string {
  const { columns, rows } = result;
  if (columns.length === 0) {
    return "";
  }

  const cells = rows.map((row) => columns.map((_, i) => cellText(row[i])));
  const widths = columns.map((col, i) =>
    Math.max(col.length, ...cells.map((row) => (row[i] ?? "").length), 1),
  );

  const sep = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  const formatRow = (vals: string[]) =>
    `|${vals.map((v, i) => ` ${v.padEnd(widths[i]!)} `).join("|")}|`;

  const lines = [sep, formatRow(columns), sep];
  for (const row of cells) {
    lines.push(formatRow(row));
  }
  lines.push(sep);
  return lines.join("\n");
}

function formatElapsedSec(ms: number): string {
  return (ms / 1000).toFixed(2);
}

function formatQueryOutput(result: DbQueryResult, elapsedMs: number): string {
  const sec = formatElapsedSec(elapsedMs);
  if (result.columns.length > 0) {
    const table = formatMysqlAsciiTable(result);
    const n = result.rows.length;
    const rowLabel = n === 1 ? "1 row in set" : `${n} rows in set`;
    return `${table}\n${rowLabel} (${sec} sec)`;
  }
  const affected = result.rowsAffected ?? 0;
  const verb = affected === 1 ? "1 row affected" : `${affected} rows affected`;
  return `Query OK, ${verb} (${sec} sec)`;
}

function resolvePrompt(dbType: string): string {
  const t = dbType.trim().toLowerCase();
  if (t.includes("postgres")) {
    return "postgres=# ";
  }
  if (t.includes("maria")) {
    return "mariadb> ";
  }
  return "mysql> ";
}

function resolveContinuePrompt(dbType: string): string {
  const t = dbType.trim().toLowerCase();
  if (t.includes("postgres")) {
    return "postgres-# ";
  }
  return "    -> ";
}

function isMetaClear(cmd: string): boolean {
  const s = cmd.replace(/;+\s*$/, "").trim().toLowerCase();
  return s === "clear" || s === "\\\\c" || s === "cls";
}

function isMetaHelp(cmd: string): boolean {
  const s = cmd.replace(/;+\s*$/, "").trim().toLowerCase();
  return s === "help" || s === "\\\\h" || s === "?";
}

function buildWelcome(connection: DbConnectionConfig): string[] {
  const engine = connection.db_type || "mysql";
  return [
    `OmniPanel ${engine} 命令行界面`,
    `连接: ${connection.name}  ${connection.user}@${connection.host}:${connection.port}${connection.database ? `/${connection.database}` : ""}`,
    "通过当前数据库连接执行（无需本机安装客户端）。输入 help 查看说明，clear 清屏。",
    "",
  ];
}

function initialSession(connection: DbConnectionConfig) {
  const saved = loadCliReplSession(connection.id);
  if (saved) {
    return saved;
  }
  return {
    lines: buildWelcome(connection),
    buffer: "",
    input: "",
    history: [] as string[],
  };
}

export function ConnectionSqlConsolePanel({
  connection,
  panelActive,
  visible,
}: ConnectionSqlConsolePanelProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const runIdRef = useRef<string | null>(null);
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");
  const connectionIdRef = useRef(connection.id);

  const prompt = useMemo(() => resolvePrompt(connection.db_type), [connection.db_type]);
  const continuePrompt = useMemo(
    () => resolveContinuePrompt(connection.db_type),
    [connection.db_type],
  );

  const [boot] = useState(() => initialSession(connection));
  const [lines, setLines] = useState(() => boot.lines);
  const [buffer, setBuffer] = useState(() => boot.buffer);
  const [input, setInput] = useState(() => boot.input);
  const [history, setHistory] = useState<string[]>(() => boot.history);
  const [running, setRunning] = useState(false);

  const activePrompt = buffer.trim() ? continuePrompt : prompt;
  const sessionVisible = visible && panelActive;

  // 仅在连接切换时恢复/初始化；不要因 connection 对象字段抖动而清屏
  useEffect(() => {
    if (connectionIdRef.current === connection.id) {
      return;
    }
    connectionIdRef.current = connection.id;
    const next = initialSession(connection);
    setLines(next.lines);
    setBuffer(next.buffer);
    setInput(next.input);
    setHistory(next.history);
    setRunning(false);
    runIdRef.current = null;
    historyIndexRef.current = -1;
    draftRef.current = "";
  }, [connection]);

  useEffect(() => {
    saveCliReplSession(connection.id, { lines, buffer, input, history });
  }, [connection.id, lines, buffer, input, history]);

  useEffect(() => {
    if (!sessionVisible) {
      return;
    }
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines, input, buffer, sessionVisible, running]);

  useEffect(() => {
    if (sessionVisible && !running) {
      inputRef.current?.focus();
    }
  }, [sessionVisible, running]);

  const appendOutput = useCallback((chunks: string[]) => {
    setLines((prev) => [...prev, ...chunks]);
  }, []);

  const focusInput = useCallback(
    (event?: MouseEvent) => {
      if (running) {
        return;
      }
      const target = event?.target;
      if (target instanceof HTMLElement && target.closest("textarea")) {
        return;
      }
      // 避免空白处 mousedown 抢走焦点后又立刻失焦
      event?.preventDefault();
      inputRef.current?.focus();
    },
    [running],
  );

  const runSql = useCallback(
    async (sql: string) => {
      const runId = makeQueryRunId();
      runIdRef.current = runId;
      setRunning(true);
      const started = performance.now();
      try {
        const data = await unwrapCommand(
          commands.dbExecuteQuery(connection, sql, runId, RESULT_ROW_LIMIT, 0),
        );
        const elapsedMs = Math.round(performance.now() - started);
        appendOutput(["", formatQueryOutput(data, elapsedMs), ""]);
      } catch (err) {
        if (isQueryCancelledError(err)) {
          appendOutput(["", t("database.connectionInfo.cli.queryCancelled"), ""]);
        } else {
          const message =
            err instanceof Error
              ? err.message
              : formatIpcError(err as { message?: string });
          appendOutput(["", `ERROR: ${message}`, ""]);
        }
      } finally {
        if (runIdRef.current === runId) {
          runIdRef.current = null;
        }
        setRunning(false);
      }
    },
    [appendOutput, connection, t],
  );

  const submitLine = useCallback(
    async (rawLine: string) => {
      const line = rawLine.replace(/\r/g, "");
      const display = `${activePrompt}${line}`;
      const nextBuffer = buffer ? `${buffer}\n${line}` : line;
      const trimmed = nextBuffer.trim();

      appendOutput([display]);
      setInput("");
      historyIndexRef.current = -1;
      draftRef.current = "";

      if (!trimmed) {
        setBuffer("");
        return;
      }

      if (!buffer && isMetaClear(trimmed)) {
        setBuffer("");
        setLines([]);
        return;
      }

      if (!buffer && isMetaHelp(trimmed)) {
        setBuffer("");
        appendOutput([
          "",
          "帮助:",
          "  输入 SQL，以分号 ; 结束并回车执行",
          "  clear / cls     清屏",
          "  help / ?        显示本帮助",
          "  ↑ / ↓           浏览历史命令",
          "",
        ]);
        return;
      }

      if (!trimmed.endsWith(";")) {
        setBuffer(nextBuffer);
        return;
      }

      setBuffer("");
      const sql = trimmed;
      if (sql.replace(/;+\s*$/, "").trim()) {
        setHistory((prev) => [sql, ...prev.filter((item) => item !== sql)].slice(0, HISTORY_LIMIT));
        await runSql(sql);
      }
    },
    [activePrompt, appendOutput, buffer, runSql],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (running) {
        if (event.key === "c" && (event.ctrlKey || event.metaKey) && runIdRef.current) {
          event.preventDefault();
          void unwrapCommand(commands.dbCancelQuery(runIdRef.current), { quiet: true }).catch(
            () => undefined,
          );
        }
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submitLine(input);
        return;
      }

      if (event.key === "l" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setLines([]);
        setBuffer("");
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (history.length === 0) {
          return;
        }
        if (historyIndexRef.current === -1) {
          draftRef.current = input;
        }
        const nextIndex = Math.min(historyIndexRef.current + 1, history.length - 1);
        historyIndexRef.current = nextIndex;
        setInput(history[nextIndex] ?? "");
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (historyIndexRef.current === -1) {
          return;
        }
        const nextIndex = historyIndexRef.current - 1;
        if (nextIndex < 0) {
          historyIndexRef.current = -1;
          setInput(draftRef.current);
          return;
        }
        historyIndexRef.current = nextIndex;
        setInput(history[nextIndex] ?? "");
      }
    },
    [history, input, running, submitLine],
  );

  return (
    <div
      className={`db-connection-cli db-cli-repl${sessionVisible ? "" : " db-connection-cli--hidden"}`}
      onMouseDown={focusInput}
    >
      <div className="db-cli-repl-screen" ref={scrollRef} onMouseDown={focusInput}>
        <pre className="db-cli-repl-output">{lines.join("\n")}</pre>
        <div className="db-cli-repl-input-row">
          <span className="db-cli-repl-prompt">{activePrompt}</span>
          <textarea
            ref={inputRef}
            className="db-cli-repl-input"
            value={input}
            rows={1}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={running}
            placeholder={running ? t("database.connectionInfo.cli.running") : undefined}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        {/* 占满下方空白，点击即可聚焦（与真实终端一致） */}
        <div className="db-cli-repl-filler" aria-hidden />
      </div>
    </div>
  );
}
