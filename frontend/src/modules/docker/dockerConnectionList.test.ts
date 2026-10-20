import { beforeEach, describe, expect, it } from "vitest";
import type { Connection, DockerConnectionInfo } from "@/ipc/bindings";
import {
  applyProbedDockerConnections,
  clearAllDockerProbePending,
  isDockerConnectionProbePending,
  markDockerProbePending,
  reconcileDockerConnections,
} from "./dockerConnectionList";

function storedDocker(id: string, name: string, source = "ssh-engine"): Connection {
  return {
    id,
    kind: "docker",
    name,
    envTag: "dev",
    config: JSON.stringify({
      source,
      host: "10.0.0.8",
      boundSshConnectionId: "ssh-1",
    }),
  };
}

function probed(id: string, status: DockerConnectionInfo["status"]): DockerConnectionInfo {
  return {
    connectionId: id,
    name: id,
    source: "ssh-engine",
    status,
    hostLabel: "10.0.0.8",
    environment: "dev",
    engineVersion: "24.0.0",
    apiVersion: "1.43",
    containersRunning: 1,
    containersTotal: 2,
    warningMessage: null,
    boundSshConnectionId: "ssh-1",
  };
}

describe("reconcileDockerConnections", () => {
  beforeEach(() => {
    clearAllDockerProbePending();
  });

  it("连接库里的新 Docker 连接立刻进列表，不必等探测", () => {
    const { connections, addedIds } = reconcileDockerConnections([], [storedDocker("docker-a", "Docker - a")]);
    expect(addedIds).toEqual(["docker-a"]);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.name).toBe("Docker - a");
    expect(connections[0]?.source).toBe("ssh-engine");
    expect(connections[0]?.boundSshConnectionId).toBe("ssh-1");
    markDockerProbePending(addedIds);
    expect(isDockerConnectionProbePending("docker-a")).toBe(true);
  });

  it("已有节点保留探测状态，改名立即反映", () => {
    const prev = [probed("docker-a", "online")];
    prev[0] = { ...prev[0]!, name: "旧名字" };
    const { connections, addedIds } = reconcileDockerConnections(prev, [
      storedDocker("docker-a", "新名字"),
    ]);
    expect(addedIds).toEqual([]);
    expect(connections[0]?.name).toBe("新名字");
    expect(connections[0]?.status).toBe("online");
    expect(connections[0]?.engineVersion).toBe("24.0.0");
  });

  it("没有变化时返回原数组", () => {
    const first = reconcileDockerConnections([], [storedDocker("docker-a", "Docker - a")]);
    const second = reconcileDockerConnections(first.connections, [storedDocker("docker-a", "Docker - a")]);
    expect(second.connections).toBe(first.connections);
    expect(second.addedIds).toEqual([]);
  });

  it("删除连接后从列表拿掉，本地 Engine 仍保留", () => {
    const local: DockerConnectionInfo = {
      ...probed("docker-local", "online"),
      name: "本地 Docker",
      source: "local-engine",
      hostLabel: "本地 Engine",
      boundSshConnectionId: null,
    };
    const prev = [local, probed("docker-a", "online")];
    const { connections } = reconcileDockerConnections(prev, []);
    expect(connections.map((item) => item.connectionId)).toEqual(["docker-local"]);
  });
});

describe("applyProbedDockerConnections", () => {
  it("用探测结果回填状态，并留下探测期间新保存的连接", () => {
    const pending = reconcileDockerConnections([], [storedDocker("docker-b", "Docker - b")]).connections;
    const next = applyProbedDockerConnections(
      pending,
      [probed("docker-a", "online")],
      [storedDocker("docker-a", "Docker - a"), storedDocker("docker-b", "Docker - b")],
    );
    expect(next.map((item) => item.connectionId)).toEqual(["docker-a", "docker-b"]);
    expect(next[0]?.status).toBe("online");
    expect(next[0]?.name).toBe("Docker - a");
    expect(next[1]?.name).toBe("Docker - b");
  });
});
