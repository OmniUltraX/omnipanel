import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Connection } from "../../../ipc/bindings";
import { connectionToResource, resolveResourceById } from "../../../stores/connectionStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import { disposePaneBackendSession } from "../../../hooks/useTerminal";
import { useTerminalUiStore } from "../../terminal/terminalUiStore";
import {
  setTerminalPaneSender,
  terminalPaneSenders,
} from "../../terminal/terminalPaneSenders";
import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import type { DbConnectionConfig } from "../api";
import type { MysqlDeploymentInfo } from "../mysqlDeploymentDetect";
import type { RedisDeploymentInfo } from "../redisDeploymentDetect";
import { dbCliEmbeddedPaneId } from "../databaseCliTerminal";
import {
  listCliTerminalModes,
  resolveDefaultCliTerminalModeId,
  type CliTerminalModeId,
  type CliTerminalModeOption,
} from "./connectionCliCommands";

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

interface UseConnectionCliTerminalOptions {
  connection: DbConnectionConfig;
  client: "mysql" | "redis";
  deployment: MysqlDeploymentInfo | RedisDeploymentInfo | null;
  deploymentLoading?: boolean;
  sshConnections: Connection[];
  /** 连接信息面板是否处于激活态；关闭面板时才断开 SSH。 */
  panelActive: boolean;
  t: TranslateFn;
}

function waitAndLaunchSteps(
  paneId: string,
  steps: string[],
  remote: boolean,
  onDone: () => void,
): () => void {
  let cancelled = false;
  let attempts = 0;
  const initialDelay = remote ? 400 : 150;
  const betweenSteps = remote ? 900 : 200;

  const timer = window.setInterval(() => {
    if (cancelled) {
      return;
    }
    attempts += 1;
    const sender = terminalPaneSenders[paneId];
    if (!sender) {
      if (attempts >= 80) {
        window.clearInterval(timer);
      }
      return;
    }
    window.clearInterval(timer);

    let stepIndex = 0;
    const runNext = () => {
      if (cancelled || stepIndex >= steps.length) {
        onDone();
        return;
      }
      const delay = stepIndex === 0 ? initialDelay : betweenSteps;
      window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        sender(`${steps[stepIndex]}\n`);
        stepIndex += 1;
        runNext();
      }, delay);
    };
    runNext();
  }, 100);

  return () => {
    cancelled = true;
    window.clearInterval(timer);
  };
}

export function useConnectionCliTerminal({
  connection,
  client,
  deployment,
  deploymentLoading = false,
  sshConnections,
  panelActive,
  t,
}: UseConnectionCliTerminalOptions) {
  const upsertEmbeddedPane = useTerminalStore((state) => state.upsertEmbeddedPane);
  const removeEmbeddedPane = useTerminalStore((state) => state.removeEmbeddedPane);
  const embeddedPanes = useTerminalStore((state) => state.embeddedPanes);
  const setInputMode = useTerminalUiStore((state) => state.setInputMode);

  const paneId = useMemo(() => dbCliEmbeddedPaneId(connection.id), [connection.id]);
  const terminalModes = useMemo(
    () => listCliTerminalModes(client, t, connection, deployment, sshConnections),
    [client, connection, deployment, sshConnections, t],
  );

  const [modeId, setModeId] = useState<CliTerminalModeId>("direct");
  const [reconnectKey, setReconnectKey] = useState(0);
  const launchTokenRef = useRef(0);
  const hasLaunchedRef = useRef(false);

  const activeMode = useMemo<CliTerminalModeOption | null>(() => {
    return terminalModes.find((mode) => mode.id === modeId) ?? terminalModes[0] ?? null;
  }, [modeId, terminalModes]);

  const deploymentReady = !deploymentLoading || deployment != null;

  const modeSignature = useMemo(
    () =>
      activeMode
        ? `${activeMode.id}:${activeMode.paneType}:${activeMode.resourceId}`
        : null,
    [activeMode],
  );
  const prevModeSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    setModeId((prev) => {
      if (terminalModes.some((mode) => mode.id === prev)) {
        return prev;
      }
      return resolveDefaultCliTerminalModeId(deployment, terminalModes);
    });
  }, [connection.id, deployment?.kind, terminalModes]);

  const pane = embeddedPanes[paneId] ?? null;

  const resource = useMemo<WorkspaceResource | null>(() => {
    if (!activeMode) {
      return null;
    }
    if (activeMode.paneType === "local") {
      return resolveResourceById("local-terminal");
    }
    const ssh = sshConnections.find((item) => item.id === activeMode.resourceId);
    return ssh ? connectionToResource(ssh) : null;
  }, [activeMode, sshConnections]);

  const syncPane = useCallback(() => {
    if (!panelActive || !activeMode) {
      return;
    }
    setInputMode(paneId, "interactive");
    upsertEmbeddedPane({
      id: paneId,
      title: client === "mysql" ? "mysql" : "redis-cli",
      type: activeMode.paneType,
      resourceId: activeMode.resourceId,
      shellLabel: activeMode.paneType === "remote" ? "SSH" : "Shell",
      cwd: "~/",
      purpose: client === "mysql" ? "MySQL CLI" : "Redis CLI",
      commandPack: activeMode.launchSteps,
    });
  }, [activeMode, client, panelActive, paneId, setInputMode, upsertEmbeddedPane]);

  useEffect(() => {
    if (!panelActive) {
      hasLaunchedRef.current = false;
      disposePaneBackendSession(paneId);
      removeEmbeddedPane(paneId);
      prevModeSignatureRef.current = null;
      return;
    }
    if (!deploymentReady || !activeMode) {
      return;
    }
    syncPane();
  }, [activeMode, deploymentReady, panelActive, paneId, removeEmbeddedPane, syncPane]);

  useEffect(() => {
    if (!panelActive || !deploymentReady) {
      return;
    }
    const prev = prevModeSignatureRef.current;
    if (prev != null && modeSignature != null && prev !== modeSignature) {
      hasLaunchedRef.current = false;
      disposePaneBackendSession(paneId);
      setReconnectKey((value) => value + 1);
    }
    prevModeSignatureRef.current = modeSignature;
  }, [deploymentReady, modeSignature, panelActive, paneId]);

  useEffect(() => {
    return () => {
      hasLaunchedRef.current = false;
      disposePaneBackendSession(paneId);
      removeEmbeddedPane(paneId);
    };
  }, [paneId, removeEmbeddedPane]);

  useEffect(() => {
    if (!panelActive || !activeMode || !deploymentReady || hasLaunchedRef.current) {
      return;
    }
    launchTokenRef.current += 1;
    const token = launchTokenRef.current;
    const cleanup = waitAndLaunchSteps(
      paneId,
      activeMode.launchSteps,
      activeMode.paneType === "remote",
      () => {
        if (launchTokenRef.current !== token) {
          return;
        }
        hasLaunchedRef.current = true;
      },
    );
    return cleanup;
  }, [activeMode, deploymentReady, panelActive, paneId, reconnectKey]);

  const handleSenderChange = useCallback(
    (sessionId: string, sender: ((cmd: string) => void) | null) => {
      setTerminalPaneSender(sessionId, sender);
    },
    [],
  );

  const handleReconnect = useCallback(() => {
    hasLaunchedRef.current = false;
    disposePaneBackendSession(paneId);
    removeEmbeddedPane(paneId);
    setReconnectKey((value) => value + 1);
    syncPane();
  }, [paneId, removeEmbeddedPane, syncPane]);

  const handleModeChange = useCallback((nextModeId: CliTerminalModeId) => {
    if (nextModeId === modeId) {
      return;
    }
    hasLaunchedRef.current = false;
    disposePaneBackendSession(paneId);
    removeEmbeddedPane(paneId);
    setModeId(nextModeId);
    setReconnectKey((value) => value + 1);
  }, [modeId, paneId, removeEmbeddedPane]);

  return {
    paneId,
    pane,
    resource,
    terminalModes,
    activeMode,
    modeId,
    reconnectKey,
    handleSenderChange,
    handleReconnect,
    handleModeChange,
  };
}
