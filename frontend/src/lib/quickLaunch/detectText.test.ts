import { describe, expect, it } from "vitest";
import {
  detectEntities,
  isDestructiveSql,
  looksLikeSql,
} from "./detectText";
import { buildSuggestions } from "./buildSuggestions";
import type { Connection } from "../../ipc/bindings";
import type { QuickLaunchRecentEntry } from "../../stores/quickLauncherRecentStore";

describe("detectEntities", () => {
  it("detects ipv4", () => {
    const entities = detectEntities("192.168.1.1");
    expect(entities.some((e) => e.kind === "ipv4")).toBe(true);
    expect(entities.find((e) => e.kind === "ipv4")?.payload.host).toBe("192.168.1.1");
  });

  it("detects host:port", () => {
    const entities = detectEntities("10.0.0.1:3306");
    expect(entities.some((e) => e.kind === "hostPort")).toBe(true);
    const hp = entities.find((e) => e.kind === "hostPort")!;
    expect(hp.payload.host).toBe("10.0.0.1");
    expect(hp.payload.port).toBe("3306");
  });

  it("detects whitelisted domain", () => {
    const entities = detectEntities("example.com");
    expect(entities.some((e) => e.kind === "domain")).toBe(true);
  });

  it("does not treat foo.bar as domain without whitelist TLD", () => {
    const entities = detectEntities("foo.bar");
    expect(entities.some((e) => e.kind === "domain")).toBe(false);
  });

  it("detects sql select", () => {
    expect(looksLikeSql("SELECT * FROM users WHERE id = 1")).toBe(true);
    const entities = detectEntities("SELECT * FROM users WHERE id = 1");
    expect(entities.some((e) => e.kind === "sql")).toBe(true);
  });

  it("marks destructive sql", () => {
    expect(isDestructiveSql("DELETE FROM users WHERE id = 1")).toBe(true);
    expect(isDestructiveSql("SELECT 1")).toBe(false);
  });

  it("detects chinese natural language", () => {
    const entities = detectEntities("帮我总结一下这段需求文档");
    expect(entities.some((e) => e.kind === "naturalLanguage")).toBe(true);
  });

  it("detects url and gitUrl together", () => {
    const entities = detectEntities("https://github.com/foo/bar.git");
    expect(entities.some((e) => e.kind === "url")).toBe(true);
    expect(entities.some((e) => e.kind === "gitUrl")).toBe(true);
  });

  it("detects json", () => {
    const entities = detectEntities('{"a":1}');
    expect(entities.some((e) => e.kind === "json")).toBe(true);
  });

  it("detects shell command", () => {
    const entities = detectEntities("docker ps -a");
    expect(entities.some((e) => e.kind === "shellCommand")).toBe(true);
  });

  it("detects windows path", () => {
    const entities = detectEntities("C:\\Users\\chaoj\\dev\\omnipanel");
    expect(entities.some((e) => e.kind === "filePath")).toBe(true);
  });
});

describe("buildSuggestions", () => {
  const dbConn: Connection = {
    id: "db-1",
    kind: "database",
    name: "Prod MySQL",
    config: JSON.stringify({
      host: "10.0.0.1",
      port: 3306,
      database: "app",
      db_type: "mysql",
    }),
  };

  const sshConn: Connection = {
    id: "ssh-1",
    kind: "ssh",
    name: "Prod SSH",
    config: JSON.stringify({ host: "192.168.1.10", port: 22 }),
  };

  const recent: QuickLaunchRecentEntry[] = [
    {
      key: "db-database:db-1:app",
      target: { type: "db-database", connectionId: "db-1", database: "app" },
      label: "app",
      useCount: 5,
      lastUsedAt: Date.now(),
    },
  ];

  it("suggests ping for ipv4", () => {
    const actions = buildSuggestions("192.168.1.10", {
      connections: [sshConn, dbConn],
      recentEntries: [],
    });
    expect(actions.some((a) => a.action.kind === "run-terminal")).toBe(true);
    expect(actions.some((a) => a.action.kind === "ssh-connection")).toBe(true);
  });

  it("suggests sql execute on recent db", () => {
    const sql = "SELECT * FROM users LIMIT 10";
    const actions = buildSuggestions(sql, {
      connections: [dbConn],
      recentEntries: recent,
    });
    const exec = actions.find(
      (a) => a.action.kind === "run-sql" && a.action.mode === "execute",
    );
    expect(exec).toBeTruthy();
    if (exec?.action.kind === "run-sql") {
      expect(exec.action.connectionId).toBe("db-1");
      expect(exec.action.database).toBe("app");
    }
    expect(actions.some((a) => a.action.kind === "run-sql" && a.action.mode === "draft")).toBe(
      true,
    );
    expect(actions.some((a) => a.action.kind === "ask-ai")).toBe(true);
  });

  it("suggests ai/note/todo for chinese text", () => {
    const actions = buildSuggestions("明天记得核对 Vault 往返单测", {
      connections: [],
      recentEntries: [],
    });
    expect(actions.some((a) => a.action.kind === "ask-ai")).toBe(true);
    expect(actions.some((a) => a.action.kind === "save-note")).toBe(true);
    expect(actions.some((a) => a.action.kind === "create-todo")).toBe(true);
  });

  it("limits suggestions to maxSuggestions", () => {
    const actions = buildSuggestions("SELECT 1", {
      connections: [dbConn],
      recentEntries: recent,
      maxSuggestions: 2,
    });
    expect(actions.length).toBeLessThanOrEqual(2);
  });
});
