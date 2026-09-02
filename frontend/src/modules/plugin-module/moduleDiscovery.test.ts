import { describe, expect, it } from "vitest";
import type { Connection } from "../../ipc/bindings";
import { buildServiceCandidate, isDuplicateService, serviceRemoteId } from "./serviceDedupe";

function conn(partial: Partial<Connection> & Pick<Connection, "id" | "kind" | "name">): Connection {
  return {
    group: "",
    envTag: "dev",
    tags: [],
    config: "{}",
    ...partial,
  };
}

describe("moduleDiscovery", () => {
  it("按 pluginId + host:port 去重", () => {
    const existing = [
      conn({
        id: "a",
        kind: "service",
        name: "local",
        config: JSON.stringify({
          pluginId: "omni.module.nacos",
          host: "127.0.0.1",
          port: 8848,
        }),
      }),
    ];
    expect(isDuplicateService(existing, "omni.module.nacos", "127.0.0.1", 8848)).toBe(true);
    expect(isDuplicateService(existing, "omni.module.nacos", "127.0.0.1", 9848)).toBe(false);
    expect(isDuplicateService(existing, "omni.module.starter", "127.0.0.1", 8848)).toBe(false);
  });

  it("externalSource remoteId 去重", () => {
    const existing = [
      conn({
        id: "b",
        kind: "service",
        name: "imported",
        config: JSON.stringify({
          pluginId: "omni.module.nacos",
          host: "10.0.0.2",
          port: 8848,
          externalSource: {
            pluginId: "omni.module.nacos",
            remoteId: "10.0.0.2:8848",
            remoteKind: "service",
          },
        }),
      }),
    ];
    expect(isDuplicateService(existing, "omni.module.nacos", "10.0.0.2", 8848)).toBe(true);
  });

  it("候选 remoteId 稳定", () => {
    const candidate = buildServiceCandidate("omni.module.nacos", "127.0.0.1", 8848);
    expect(candidate.remoteId).toBe(serviceRemoteId("127.0.0.1", 8848));
    expect(candidate.remoteKind).toBe("service");
  });
});
