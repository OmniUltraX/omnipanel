import {
  createBtPanelClient,
  type BtJavaProjectLoadInfo,
} from "../../../../lib/btpanel";
import type { Connection } from "../../../../ipc/bindings";
import { connectionToServerEntry } from "../../../server/panel/panelConnection";

export async function fetchBtJavaWebsiteLoad(
  connection: Connection,
  projectName: string,
): Promise<BtJavaProjectLoadInfo> {
  const server = connectionToServerEntry(connection);
  console.debug("[bt-java-load] fetch start", {
    connectionId: connection.id,
    connectionName: connection.name,
    address: server.address,
    serviceType: server.serviceType,
    projectName,
  });
  const client = createBtPanelClient(server.address, server.key, server.id);
  try {
    const info = await client.getJavaProjectLoadInfo(projectName);
    console.debug("[bt-java-load] fetch ok", {
      connectionId: connection.id,
      projectName,
      cpuPercent: info.cpuPercent,
      memoryPercent: info.memoryPercent,
      memoryUsedBytes: info.memoryUsedBytes,
      raw: info.raw,
    });
    return info;
  } catch (error) {
    console.error("[bt-java-load] fetch error", {
      connectionId: connection.id,
      projectName,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : error,
    });
    throw error;
  }
}
