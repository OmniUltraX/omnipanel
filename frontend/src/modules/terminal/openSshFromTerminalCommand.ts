import type { Connection } from "../../ipc/bindings";
import { commands } from "../../ipc/bindings";
import { openSshTerminalSession } from "../../lib/terminalSession";
import { quickInput } from "../../lib/quickInput";
import {
  buildSshConnection,
  connectionsToForm,
  EMPTY_SERVER_FORM,
  parseSshConfig,
  type UnifiedServerFormData,
} from "../server/panel/serverConnection";
import { createBlockId, useBlocksStore } from "../../stores/blocksStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { showToast } from "../../stores/toastStore";
import { parseSshConnectCommand } from "./parseSshConnectCommand";

function findExistingSshConnection(
  connections: Connection[],
  parsed: ReturnType<typeof parseSshConnectCommand>,
): Connection | undefined {
  if (!parsed) return undefined;
  return connections.find((connection) => {
    if (connection.kind !== "ssh") return false;
    const cfg = parseSshConfig(connection);
    if (!cfg) return false;
    return (
      cfg.host === parsed.host &&
      cfg.port === parsed.port &&
      cfg.user === parsed.user
    );
  });
}

function buildFormFromParsed(
  parsed: NonNullable<ReturnType<typeof parseSshConnectCommand>>,
): UnifiedServerFormData {
  const displayName = `${parsed.user}@${parsed.host}:${parsed.port}`;
  if (parsed.identityFile) {
    return {
      ...EMPTY_SERVER_FORM,
      name: displayName,
      host: parsed.host,
      port: String(parsed.port),
      user: parsed.user,
      authType: "privateKey",
      keyPath: parsed.identityFile,
    };
  }
  return {
    ...EMPTY_SERVER_FORM,
    name: displayName,
    host: parsed.host,
    port: String(parsed.port),
    user: parsed.user,
    authType: "privateKey",
    keyPath: "auto",
  };
}

function isAuthFailure(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "auth") return true;
  return /认证|auth/i.test(error.message ?? "");
}

async function probeSshConnection(
  connectionId: string,
): Promise<{ ok: true } | { ok: false; authFailed: boolean }> {
  const res = await commands.sshConnectConnection(connectionId, 80, 24);
  if (res.status === "ok") {
    void commands.sshDisconnect(res.data);
    return { ok: true };
  }
  return { ok: false, authFailed: isAuthFailure(res.error) };
}

async function ensureSshConnectionReady(
  connection: Connection,
  messages: SshTerminalCommandMessages,
): Promise<Connection | null> {
  let current = connection;
  let probe = await probeSshConnection(current.id);
  if (probe.ok) return current;

  if (!probe.authFailed) {
    showToast(messages.connectFailed);
    return current;
  }

  const password = await quickInput({
    title: messages.passwordPromptTitle,
    subtitle: messages.passwordPromptSubtitle(current.name),
    placeholder: messages.passwordPromptPlaceholder,
    validate: (value) => (value.trim() ? null : messages.passwordRequired),
  });
  if (!password) {
    showToast(messages.passwordCancelled);
    return null;
  }

  const form = connectionsToForm(current);
  form.authType = "password";
  form.password = password;
  current =
    (await useConnectionStore.getState().save(
      buildSshConnection(
        form,
        current.id,
        undefined,
        current.tags,
        current,
      ),
    )) ?? current;

  probe = await probeSshConnection(current.id);
  if (!probe.ok) {
    showToast(messages.authFailed);
    return null;
  }
  return current;
}

export type SshTerminalCommandMessages = {
  openedExisting: (name: string) => string;
  openedNew: (name: string) => string;
  saveFailed: string;
  connectFailed: string;
  authFailed: string;
  passwordPromptTitle: string;
  passwordPromptSubtitle: (name: string) => string;
  passwordPromptPlaceholder: string;
  passwordRequired: string;
  passwordCancelled: string;
};

export type OpenSshFromTerminalOptions = {
  /** 发起命令的终端标签/会话 id，用于写入可回跳的历史 block */
  sourceSessionId?: string;
};

function resolveSourceSessionCwd(sessionId: string): string {
  const state = useTerminalStore.getState();
  const tab = state.tabs.find(
    (item) => item.id === sessionId || item.sessionId === sessionId,
  );
  const pane = state.embeddedPanes[sessionId];
  const cwd = (pane?.cwd || tab?.session.cwd || "").trim();
  return cwd || "~";
}

function recordSshCommandJumpBlock(
  sourceSessionId: string,
  command: string,
  linkedTabId: string,
  linkedTabTitle: string,
): void {
  useBlocksStore.getState().addBlock(sourceSessionId, {
    id: createBlockId(),
    sessionId: sourceSessionId,
    kind: "shell",
    command: command.trim(),
    output: "",
    exitCode: 0,
    startLine: -1,
    endLine: -1,
    marker: null,
    cwd: resolveSourceSessionCwd(sourceSessionId),
    timestamp: Date.now(),
    completedAt: Date.now(),
    status: "completed",
    linkedTabId,
    linkedTabTitle,
  });
}

/**
 * 若命令为可识别的 SSH 连接命令，则保存/匹配主机并打开终端标签。
 * 返回 true 表示已接管，不应再发送到当前 PTY。
 */
export async function tryOpenSshFromTerminalCommand(
  command: string,
  messages: SshTerminalCommandMessages,
  options?: OpenSshFromTerminalOptions,
): Promise<boolean> {
  const parsed = parseSshConnectCommand(command);
  if (!parsed) return false;

  const store = useConnectionStore.getState();
  let connection = findExistingSshConnection(store.connections, parsed);
  const isNew = !connection;

  if (connection) {
    if (parsed.identityFile) {
      const form = connectionsToForm(connection);
      form.authType = "privateKey";
      form.keyPath = parsed.identityFile;
      connection =
        (await store.save(
          buildSshConnection(
            form,
            connection.id,
            undefined,
            connection.tags,
            connection,
          ),
        )) ?? connection;
    }
  } else {
    connection =
      (await store.save(buildSshConnection(buildFormFromParsed(parsed)))) ??
      undefined;
  }

  if (!connection) {
    showToast(messages.saveFailed);
    return true;
  }

  const ready = await ensureSshConnectionReady(connection, messages);
  if (!ready) {
    return true;
  }
  connection = ready;

  const tabId = openSshTerminalSession(connection.id);
  if (!tabId) {
    showToast(messages.saveFailed);
    return true;
  }

  if (options?.sourceSessionId && options.sourceSessionId !== tabId) {
    recordSshCommandJumpBlock(
      options.sourceSessionId,
      command,
      tabId,
      connection.name,
    );
  }

  showToast(
    isNew
      ? messages.openedNew(connection.name)
      : messages.openedExisting(connection.name),
  );
  return true;
}
