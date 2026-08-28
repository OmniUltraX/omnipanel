import { describe, expect, it } from "vitest";
import type { ImporterScannerRule } from "@omnipanel/plugin-sdk";
import {
  imageMatchesNeedle,
  isContainerLanHost,
  matchScannerRule,
  publishedPort,
  resolveDockerReachableHost,
  scanContainerToCandidate,
  stripHostUserAndPort,
} from "./dockerDbScan";

const rules: ImporterScannerRule[] = [
  {
    id: "mysql",
    images: ["mysql", "mariadb"],
    dbType: "mysql",
    defaultPort: 3306,
    userEnv: ["MYSQL_USER", "MARIADB_USER"],
    passwordEnv: ["MYSQL_ROOT_PASSWORD", "MYSQL_PASSWORD", "MARIADB_ROOT_PASSWORD", "MARIADB_PASSWORD"],
    databaseEnv: ["MYSQL_DATABASE", "MARIADB_DATABASE"],
    defaultUser: "root",
  },
  {
    id: "postgres",
    images: ["postgres"],
    dbType: "postgres",
    defaultPort: 5432,
    userEnv: ["POSTGRES_USER"],
    passwordEnv: ["POSTGRES_PASSWORD"],
    databaseEnv: ["POSTGRES_DB"],
    defaultUser: "postgres",
  },
];

describe("dockerDbScan", () => {
  it("按镜像末段匹配 mysql / mariadb / postgres，不误伤无关镜像", () => {
    expect(imageMatchesNeedle("mysql:8", "mysql")).toBe(true);
    expect(imageMatchesNeedle("library/mariadb:11", "mariadb")).toBe(true);
    expect(imageMatchesNeedle("bitnami/postgresql:16", "postgres")).toBe(true);
    expect(imageMatchesNeedle("redis:7", "mysql")).toBe(false);
    expect(imageMatchesNeedle("nginx:latest", "postgres")).toBe(false);
    expect(matchScannerRule("postgres:16-alpine", rules)?.id).toBe("postgres");
    expect(matchScannerRule("redis:7", rules)).toBeNull();
  });

  it("路径段能命中 mssql/server、clickhouse-server、mongo", () => {
    expect(imageMatchesNeedle("mcr.microsoft.com/mssql/server:2022-latest", "mssql")).toBe(true);
    expect(imageMatchesNeedle("clickhouse/clickhouse-server:24", "clickhouse")).toBe(true);
    expect(imageMatchesNeedle("mongo:7", "mongo")).toBe(true);
    expect(imageMatchesNeedle("qdrant/qdrant:latest", "qdrant")).toBe(true);
    expect(imageMatchesNeedle("redis:7-alpine", "redis")).toBe(true);
    expect(imageMatchesNeedle("nginx:latest", "mssql")).toBe(false);
  });

  it("未发布主机端口则跳过，已发布则用 PublishedPort", () => {
    expect(publishedPort([{ privatePort: 3306, publicPort: null, protocol: "tcp", ip: null }], 3306)).toBeNull();
    expect(publishedPort([{ privatePort: 3306, publicPort: 0, protocol: "tcp", ip: "0.0.0.0" }], 3306)).toBeNull();
    expect(publishedPort([{ privatePort: 3306, publicPort: 13306, protocol: "tcp", ip: "0.0.0.0" }], 3306)).toBe(
      13306,
    );
  });

  it("禁止把 Docker 桥地址写成 host，局域网引擎地址可以", () => {
    expect(isContainerLanHost("172.17.0.2")).toBe(true);
    expect(isContainerLanHost("10.0.0.8")).toBe(false);
    expect(isContainerLanHost("192.168.1.10")).toBe(false);
    expect(isContainerLanHost("127.0.0.1")).toBe(false);
    expect(isContainerLanHost("db.example.com")).toBe(false);
  });

  it("本地引擎固定 127.0.0.1；SSH/远程用引擎地址，不用 hostLabel 里的容器 IP", () => {
    expect(
      resolveDockerReachableHost({
        connectionId: "docker-local",
        source: "local-engine",
        hostLabel: "172.17.0.2",
      }),
    ).toBe("127.0.0.1");
    expect(
      resolveDockerReachableHost({
        connectionId: "d-remote",
        source: "remote-engine",
        hostLabel: "172.17.0.2",
        dockerConfig: { host: "172.17.0.2" },
      }),
    ).toBeNull();
    expect(
      resolveDockerReachableHost({
        connectionId: "d-remote",
        source: "remote-engine",
        hostLabel: "172.17.0.2",
        dockerConfig: { host: "10.0.0.3" },
      }),
    ).toBe("10.0.0.3");
    expect(
      resolveDockerReachableHost({
        connectionId: "d-remote",
        source: "remote-engine",
        hostLabel: "172.17.0.2",
        dockerConfig: { host: "docker.prod.example" },
      }),
    ).toBe("docker.prod.example");
    expect(
      resolveDockerReachableHost({
        connectionId: "d-ssh",
        source: "ssh-engine",
        hostLabel: "root@172.17.0.2",
        sshHost: "ops@203.0.113.10:22",
      }),
    ).toBe("203.0.113.10");
    expect(
      resolveDockerReachableHost({
        connectionId: "d-panel",
        source: "one-panel",
        hostLabel: "panel",
        dockerConfig: { onepanel: { baseUrl: "https://panel.example.com:443" } },
      }),
    ).toBe("panel.example.com");
    expect(stripHostUserAndPort("root@203.0.113.10:22")).toBe("203.0.113.10");
  });

  it("未发布端口跳过；发布后 host 是引擎地址而不是容器 IP", () => {
    const unpublished = scanContainerToCandidate({
      pluginId: "omni.importer.docker-db",
      accountId: "docker-local",
      host: "127.0.0.1",
      container: {
        id: "c1",
        name: "/shop-mysql",
        image: "mysql:8",
        running: true,
        ports: [{ privatePort: 3306, publicPort: null, protocol: "tcp", ip: null }],
        composeProject: "shop",
        ipAddress: "172.17.0.2",
      },
      env: [
        { key: "MYSQL_ROOT_PASSWORD", value: "s3cret" },
        { key: "MYSQL_DATABASE", value: "shop" },
      ],
      rules,
    });
    expect(unpublished.skip?.reason).toBe("unpublished-port");
    expect(unpublished.candidate).toBeUndefined();

    const lanHost = scanContainerToCandidate({
      pluginId: "omni.importer.docker-db",
      accountId: "docker-local",
      host: "172.17.0.2",
      container: {
        id: "c2",
        name: "shop-mysql",
        image: "mysql:8",
        running: true,
        ports: [{ privatePort: 3306, publicPort: 3306, protocol: "tcp", ip: "0.0.0.0" }],
        ipAddress: "172.17.0.2",
      },
      env: [],
      rules,
    });
    expect(lanHost.skip?.reason).toBe("container-ip");

    const ok = scanContainerToCandidate({
      pluginId: "omni.importer.docker-db",
      accountId: "docker-local",
      host: "127.0.0.1",
      container: {
        id: "abc123",
        name: "/shop-mysql",
        image: "mysql:8",
        running: true,
        ports: [{ privatePort: 3306, publicPort: 13306, protocol: "tcp", ip: "0.0.0.0" }],
        composeProject: "shop",
        ipAddress: "172.17.0.2",
      },
      env: [
        { key: "MYSQL_ROOT_PASSWORD", value: "s3cret" },
        { key: "MYSQL_DATABASE", value: "shop" },
      ],
      rules,
      defaultGroup: "Docker",
    });
    expect(ok.candidate).toMatchObject({
      pluginId: "omni.importer.docker-db",
      accountId: "docker-local",
      remoteId: "abc123",
      remoteKind: "mysql",
      name: "shop-mysql",
      config: {
        host: "127.0.0.1",
        port: 13306,
        user: "root",
        password: "s3cret",
        database: "shop",
        importGroup: "shop",
      },
    });
    expect(String((ok.candidate?.config as { host?: string }).host)).not.toMatch(/^172\./);
  });

  it("清单规则能扫出 Redis / Mongo / SQL Server", async () => {
    const { getPluginManifest } = await import("./pluginManifests");
    const scanners = getPluginManifest("omni.importer.docker-db")?.contributes.importers?.[0]?.scanners ?? [];
    expect(scanners.map((rule) => rule.id)).toEqual([
      "mysql",
      "postgres",
      "redis",
      "mongodb",
      "clickhouse",
      "sqlserver",
      "qdrant",
      "dameng",
      "cassandra",
      "neo4j",
    ]);

    const redis = scanContainerToCandidate({
      pluginId: "omni.importer.docker-db",
      accountId: "docker-local",
      host: "127.0.0.1",
      container: {
        id: "r1",
        name: "cache",
        image: "redis:7-alpine",
        running: true,
        ports: [{ privatePort: 6379, publicPort: 6379, protocol: "tcp", ip: "0.0.0.0" }],
        ipAddress: "172.17.0.4",
      },
      env: [{ key: "REDIS_PASSWORD", value: "cachepw" }],
      rules: scanners,
    });
    expect(redis.candidate).toMatchObject({
      remoteKind: "redis",
      config: { host: "127.0.0.1", port: 6379, password: "cachepw" },
    });

    const mssql = scanContainerToCandidate({
      pluginId: "omni.importer.docker-db",
      accountId: "d-ssh",
      host: "203.0.113.10",
      container: {
        id: "s1",
        name: "erp-sql",
        image: "mcr.microsoft.com/mssql/server:2022-latest",
        running: true,
        ports: [{ privatePort: 1433, publicPort: 1433, protocol: "tcp", ip: "0.0.0.0" }],
        ipAddress: "172.17.0.9",
      },
      env: [{ key: "MSSQL_SA_PASSWORD", value: "Sql_S3cret" }],
      rules: scanners,
    });
    expect(mssql.candidate).toMatchObject({
      remoteKind: "sqlserver",
      config: { host: "203.0.113.10", port: 1433, user: "sa", password: "Sql_S3cret" },
    });

    const dameng = scanContainerToCandidate({
      pluginId: "omni.importer.docker-db",
      accountId: "docker-local",
      host: "127.0.0.1",
      container: {
        id: "d1",
        name: "dameng-1",
        image: "onlyoffice/damengdb:8.1.3",
        running: true,
        ports: [{ privatePort: 5236, publicPort: 15236, protocol: "tcp", ip: "0.0.0.0" }],
        composeProject: "db-live",
        ipAddress: "172.17.0.5",
      },
      env: [{ key: "INSTANCE_NAME", value: "dm8db" }],
      rules: scanners,
    });
    expect(dameng.candidate).toMatchObject({
      remoteKind: "dameng",
      config: {
        host: "127.0.0.1",
        port: 15236,
        user: "SYSDBA",
        password: "SYSDBA_dm001",
        database: "dm8db",
        importGroup: "db-live",
      },
    });

    const neo4j = scanContainerToCandidate({
      pluginId: "omni.importer.docker-db",
      accountId: "docker-local",
      host: "127.0.0.1",
      container: {
        id: "n1",
        name: "neo4j-1",
        image: "neo4j:5-community",
        running: true,
        ports: [{ privatePort: 7687, publicPort: 17687, protocol: "tcp", ip: "0.0.0.0" }],
        ipAddress: "172.17.0.6",
      },
      env: [{ key: "NEO4J_AUTH", value: "neo4j/omni_test" }],
      rules: scanners,
    });
    expect(neo4j.candidate).toMatchObject({
      remoteKind: "neo4j",
      config: { host: "127.0.0.1", port: 17687, user: "neo4j", password: "omni_test" },
    });

    const cassandra = scanContainerToCandidate({
      pluginId: "omni.importer.docker-db",
      accountId: "docker-local",
      host: "127.0.0.1",
      container: {
        id: "c3",
        name: "cassandra-1",
        image: "cassandra:4.1",
        running: true,
        ports: [{ privatePort: 9042, publicPort: 19042, protocol: "tcp", ip: "0.0.0.0" }],
        ipAddress: "172.17.0.7",
      },
      env: [],
      rules: scanners,
    });
    expect(cassandra.candidate).toMatchObject({
      remoteKind: "cassandra",
      config: { host: "127.0.0.1", port: 19042, user: "cassandra" },
    });
  });
});
