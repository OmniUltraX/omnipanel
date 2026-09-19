import { describe, expect, it } from "vitest";
import type { Connection } from "../ipc/bindings";
import { pluginIdFromConnection } from "./pluginEnsure";

function conn(kind: Connection["kind"], config: string): Connection {
  return { id: "c1", kind, name: "n", config };
}

describe("pluginIdFromConnection", () => {
  it("reads cloud pluginId and provider aliases", () => {
    expect(
      pluginIdFromConnection(conn("cloud", '{"pluginId":"omni.cloud.aliyun"}')),
    ).toBe("omni.cloud.aliyun");
    expect(pluginIdFromConnection(conn("cloud", '{"provider":"aliyun"}'))).toBe(
      "omni.cloud.aliyun",
    );
    expect(pluginIdFromConnection(conn("cloud", '{"provider":"tencent"}'))).toBe(
      "omni.cloud.tencent",
    );
  });

  it("reads service pluginId and panel aliases", () => {
    expect(
      pluginIdFromConnection(conn("service", '{"pluginId":"omni.module.nacos"}')),
    ).toBe("omni.module.nacos");
    expect(pluginIdFromConnection(conn("panel", '{"serviceType":"bt"}'))).toBe(
      "omni.panel.bt",
    );
    expect(pluginIdFromConnection(conn("ssh", '{"pluginId":"omni.cloud.aliyun"}'))).toBeNull();
  });
});
