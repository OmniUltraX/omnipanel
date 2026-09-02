import { describe, expect, it } from "vitest";
import type { Connection } from "../../ipc/bindings";
import {
  connectionNamespaceId,
  listServiceConnections,
  withConnectionNamespaceId,
} from "./serviceConnections";

function conn(partial: Partial<Connection> & Pick<Connection, "id" | "kind" | "name">): Connection {
  return {
    group: "",
    envTag: "dev",
    tags: [],
    config: "{}",
    ...partial,
  };
}

describe("listServiceConnections", () => {
  it("只返回当前插件的 service 连接", () => {
    const rows = listServiceConnections(
      [
        conn({
          id: "a",
          kind: "service",
          name: "n1",
          config: JSON.stringify({ pluginId: "omni.module.nacos", host: "127.0.0.1" }),
        }),
        conn({
          id: "b",
          kind: "service",
          name: "other",
          config: JSON.stringify({ pluginId: "omni.module.other" }),
        }),
        conn({ id: "c", kind: "ssh", name: "ssh" }),
      ],
      "omni.module.nacos",
    );
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("读写连接上的命名空间", () => {
    const row = conn({
      id: "a",
      kind: "service",
      name: "n1",
      config: JSON.stringify({ pluginId: "omni.module.nacos", host: "127.0.0.1" }),
    });
    expect(connectionNamespaceId(row)).toBe("");
    const next = withConnectionNamespaceId(row, "dev");
    expect(connectionNamespaceId(next)).toBe("dev");
    expect((JSON.parse(next.config ?? "{}") as { pluginId?: string }).pluginId).toBe(
      "omni.module.nacos",
    );
  });
});
