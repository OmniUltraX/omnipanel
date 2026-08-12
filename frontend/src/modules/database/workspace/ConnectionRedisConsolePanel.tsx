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
import { formatMysqlAsciiTable } from "./ConnectionSqlConsolePanel";

const HISTORY_LIMIT = 100;

interface ConnectionRedisConsolePanelProps {
  connection: DbConnectionConfig;
  panelActive: boolean;
  visible: boolean;
}

function cellText(value: unknown): string {
  if (value == null) {
    return "(nil)";
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

function formatRedisScalar(value: unknown): string {
  if (value == null) {
    return "(nil)";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const text = typeof value === "string" ? value : cellText(value);
  if (/^[\w./:@*-]+$/.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

/** 仿 redis-cli 文本输出。 */
export function formatRedisOutput(result: DbQueryResult): string {
  const { columns, rows } = result;

  if (rows.length === 0) {
    if (columns.length === 1 && columns[0] === "result") {
      return "(nil)";
    }
    return "";
  }

  if (columns.length === 1) {
    const col = columns[0];
    if (col === "integer") {
      return `(integer) ${cellText(rows[0]?.[0])}`;
    }
    if (col === "status" || col === "result") {
      return formatRedisScalar(rows[0]?.[0]);
    }
  }

  if (columns.length === 2 && columns[0] === "index" && columns[1] === "value") {
    return rows
      .map((row, index) => {
        const value = row[1];
        const rendered = formatRedisScalar(value);
        if (value != null && typeof value === "object") {
          return `${index + 1}) ${rendered}`;
        }
        if (rendered === "(nil)") {
          return `${index + 1}) (nil)`;
        }
        if (/^[\w./:@*-]+$/.test(rendered)) {
          return `${index + 1}) ${rendered}`;
        }
        return `${index + 1}) ${JSON.stringify(rendered)}`;
      })
      .join("\n");
  }

  if (rows.length === 1 && columns.length > 1) {
    return columns
      .map((column, index) => `${column}: ${formatRedisScalar(rows[0]?.[index])}`)
      .join("\n");
  }

  return formatMysqlAsciiTable(result);
}

function resolvePrompt(connection: DbConnectionConfig): string {
  const host = connection.host?.trim() || "127.0.0.1";
  const port = connection.port || 6379;
  const db = connection.database?.trim();
  if (db && db !== "0") {
    return `${host}:${port}[${db}]> `;
  }
  return `${host}:${port}> `;
}

function replSessionKey(connection: DbConnectionConfig): string {
  const db = connection.database?.trim() || "0";
  return `redis:${connection.id}:${db}`;
}

function isMetaClear(cmd: string): boolean {
  const s = cmd.trim().toLowerCase();
  return s === "clear" || s === "cls";
}

function isMetaHelp(cmd: string): boolean {
  const s = cmd.trim().toLowerCase();
  return s === "help" || s === "?";
}

function buildWelcome(connection: DbConnectionConfig): string[] {
  const host = connection.host?.trim() || "127.0.0.1";
  const port = connection.port || 6379;
  const db = connection.database?.trim() || "0";
  return [
    "OmniPanel Redis 命令行",
    `连接: ${connection.name}  ${host}:${port}/${db}`,
    "通过当前数据库连接执行（无需本机安装 redis-cli）。输入 help 查看说明，clear 清屏。",
    "",
  ];
}

function initialSession(connection: DbConnectionConfig) {
  const saved = loadCliReplSession(replSessionKey(connection));
  if (saved) {
    return saved;
  }
  return {
    lines: buildWelcome(connection),
    input: "",
    history: [] as string[],
  };
}

export function ConnectionRedisConsolePanel({
  connection,
  panelActive,
  visible,
}: ConnectionRedisConsolePanelProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const runIdRef = useRef<string | null>(null);
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");
  const sessionKeyRef = useRef(replSessionKey(connection));

  const prompt = useMemo(() => resolvePrompt(connection), [connection]);

  const [boot] = useState(() => initialSession(connection));
  const [lines, setLines] = useState(() => boot.lines);
  const [input, setInput] = useState(() => boot.input);
  const [history, setHistory] = useState<string[]>(() => boot.history);
  const [running, setRunning] = useState(false);

  const sessionVisible = visible && panelActive;
  const sessionKey = replSessionKey(connection);

  useEffect(() => {
    if (sessionKeyRef.current === sessionKey) {
      return;
    }
    sessionKeyRef.current = sessionKey;
    const next = initialSession(connection);
    setLines(next.lines);
    setInput(next.input);
    setHistory(next.history);
    setRunning(false);
    runIdRef.current = null;
    historyIndexRef.current = -1;
    draftRef.current = "";
  }, [connection, sessionKey]);

  useEffect(() => {
    saveCliReplSession(sessionKey, { lines, buffer: "", input, history });
  }, [sessionKey, lines, input, history]);

  useEffect(() => {
    if (!sessionVisible) {
      return;
    }
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines, input, sessionVisible, running]);

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
      event?.preventDefault();
      inputRef.current?.focus();
    },
    [running],
  );

  const runCommand = useCallback(
    async (command: string) => {
      const runId = makeQueryRunId();
      runIdRef.current = runId;
      setRunning(true);
      try {
        const data = await unwrapCommand(
          commands.dbExecuteQuery(connection, command, runId, null, null),
        );
        const output = formatRedisOutput(data);
        appendOutput(output ? ["", output, ""] : [""]);
      } catch (err) {
        if (isQueryCancelledError(err)) {
          appendOutput(["", t("database.connectionInfo.cli.queryCancelled"), ""]);
        } else {
          const message =
            err instanceof Error
              ? err.message
              : formatIpcError(err as { message?: string });
          appendOutput(["", `(error) ${message}`, ""]);
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
      const trimmed = line.trim();

      appendOutput([`${prompt}${line}`]);
      setInput("");
      historyIndexRef.current = -1;
      draftRef.current = "";

      if (!trimmed) {
        return;
      }

      if (isMetaClear(trimmed)) {
        setLines([]);
        return;
      }

      if (isMetaHelp(trimmed)) {
        appendOutput([
          "",
          "帮助:",
          "  输入 Redis 命令并回车执行",
          "  clear / cls     清屏",
          "  help / ?        显示本帮助",
          "  ↑ / ↓           浏览历史命令",
          "",
        ]);
        return;
      }

      setHistory((prev) => [trimmed, ...prev.filter((item) => item !== trimmed)].slice(0, HISTORY_LIMIT));
      await runCommand(trimmed);
    },
    [appendOutput, prompt, runCommand],
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
          <span className="db-cli-repl-prompt">{prompt}</span>
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
        <div className="db-cli-repl-filler" aria-hidden />
      </div>
    </div>
  );
}
