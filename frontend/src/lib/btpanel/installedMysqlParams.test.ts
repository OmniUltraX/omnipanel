import { describe, expect, it } from "vitest";
import {
  BT_SOFT_MYSQL_FALLBACK_INSTALL_ID,
  BT_SOFT_REDIS_FALLBACK_INSTALL_ID,
  buildParamsFromBtDockerMysql,
  buildParamsFromBtDockerRedis,
  btSoftDbFallbackInstallId,
  btSoftMysqlInstallId,
  btSoftRedisInstallId,
  fieldMapFromAppInfo,
  isBtMysqlOrMariadbKey,
  isBtRedisKey,
  matchCloudServerForDockerMysql,
  parseBtRedisConf,
  pickDockerMysqlPassword,
  pickDockerMysqlPort,
  pickDockerMysqlUser,
  pickDockerRedisPassword,
  pickDockerRedisPort,
} from "./installedMysqlParams";
import type { BtCloudServer, BtInstalledApp } from "./types";

describe("isBtMysqlOrMariadbKey", () => {
  it("matches mysql / mariadb variants", () => {
    expect(isBtMysqlOrMariadbKey("mysql")).toBe(true);
    expect(isBtMysqlOrMariadbKey("mysql-8.0")).toBe(true);
    expect(isBtMysqlOrMariadbKey("MariaDB")).toBe(true);
    expect(isBtMysqlOrMariadbKey("nginx")).toBe(false);
  });
});

describe("btSoftMysqlInstallId", () => {
  it("uses real id when present", () => {
    expect(btSoftMysqlInstallId({ id: 42, name: "mysql" })).toBe(42);
  });
  it("falls back when id missing", () => {
    expect(btSoftMysqlInstallId({ name: "mysql" })).toBe(BT_SOFT_MYSQL_FALLBACK_INSTALL_ID);
    expect(btSoftMysqlInstallId({ id: 0, name: "mariadb" })).toBe(
      BT_SOFT_MYSQL_FALLBACK_INSTALL_ID,
    );
  });
});

describe("fieldMapFromAppInfo", () => {
  it("accepts attr/value shape from some panel builds", () => {
    const app = {
      appinfo: [{ attr: "mysql_port", name: "端口", value: "3308" }],
    } as unknown as BtInstalledApp;
    expect(fieldMapFromAppInfo(app).mysql_port).toBe("3308");
  });
});

describe("docker mysql field pickers", () => {
  it("prefers host port from mapping", () => {
    const app = { port: ["3307:3306"] } as BtInstalledApp;
    expect(pickDockerMysqlPort(app, {})).toBe("3307");
  });

  it("prefers mysql_port over generic port", () => {
    expect(
      pickDockerMysqlPort({} as BtInstalledApp, {
        port: "80",
        mysql_port: "3308",
      }),
    ).toBe("3308");
  });

  it("reads password and user from appinfo map", () => {
    const map = {
      mysql_root_password: "s3cret",
      mysql_root_user: "admin",
    };
    expect(pickDockerMysqlPassword(map)).toBe("s3cret");
    expect(pickDockerMysqlUser(map)).toBe("admin");
  });

  it("defaults user to root instead of picking mysql_user", () => {
    expect(pickDockerMysqlUser({ mysql_user: "app" })).toBe("root");
  });
});

describe("matchCloudServerForDockerMysql", () => {
  it("matches by service_name in ps", () => {
    const servers: BtCloudServer[] = [
      { id: 0, db_port: 3306, db_user: "root", db_password: "", ps: "本地服务器" },
      {
        id: 3,
        db_port: 15420,
        db_user: "root",
        db_password: "docker-pass",
        ps: "docker_mysql",
      },
    ];
    const app = {
      appname: "mysql",
      service_name: "docker_mysql",
    } as BtInstalledApp;
    const hit = matchCloudServerForDockerMysql(servers, app);
    expect(hit?.db_port).toBe(15420);
    expect(hit?.db_password).toBe("docker-pass");
  });
});

describe("buildParamsFromBtDockerMysql", () => {
  it("emits PANEL_* keys for importPanelAppToDatabase", () => {
    const app: BtInstalledApp = {
      id: "1",
      appid: 9,
      appname: "mysql",
      apptitle: "MySQL",
      service_name: "mysql_main",
      container_id: "abc",
      port: ["13306:3306"],
      appinfo: [
        { fieldKey: "MYSQL_ROOT_PASSWORD", fieldTitle: "Root", fieldValue: "p@ss" },
        { fieldKey: "mysql_port", fieldTitle: "Port", fieldValue: "13306" },
      ],
    };
    const config = buildParamsFromBtDockerMysql(app);
    const byKey = Object.fromEntries(config.params.map((p) => [p.key, String(p.value ?? "")]));
    expect(byKey.PANEL_MYSQL_PORT).toBe("13306");
    expect(byKey.PANEL_DB_ROOT_USER).toBe("root");
    expect(byKey.PANEL_DB_ROOT_PASSWORD).toBe("p@ss");
    expect(config.containerName).toBe("abc");
  });
});

describe("isBtRedisKey", () => {
  it("matches redis variants", () => {
    expect(isBtRedisKey("redis")).toBe(true);
    expect(isBtRedisKey("Redis-7")).toBe(true);
    expect(isBtRedisKey("mysql")).toBe(false);
  });
});

describe("btSoftRedisInstallId / btSoftDbFallbackInstallId", () => {
  it("uses redis fallback when id missing", () => {
    expect(btSoftRedisInstallId({ name: "redis" })).toBe(BT_SOFT_REDIS_FALLBACK_INSTALL_ID);
    expect(btSoftRedisInstallId({ id: 7, name: "redis" })).toBe(7);
  });

  it("maps app key to soft fallback install ids", () => {
    expect(btSoftDbFallbackInstallId("mysql")).toBe(BT_SOFT_MYSQL_FALLBACK_INSTALL_ID);
    expect(btSoftDbFallbackInstallId("redis")).toBe(BT_SOFT_REDIS_FALLBACK_INSTALL_ID);
    expect(btSoftDbFallbackInstallId("nginx")).toBeUndefined();
  });
});

describe("parseBtRedisConf", () => {
  it("reads port and requirepass", () => {
    const conf = `
# comment
port 6380
requirepass "s3cret"
`;
    expect(parseBtRedisConf(conf)).toEqual({ port: "6380", password: "s3cret" });
  });

  it("defaults port when absent", () => {
    expect(parseBtRedisConf("")).toEqual({ port: "6379", password: "" });
  });
});

describe("docker redis field pickers", () => {
  it("prefers host port and redis password keys", () => {
    const app = { port: ["16379:6379"] } as BtInstalledApp;
    expect(pickDockerRedisPort(app, {})).toBe("16379");
    expect(pickDockerRedisPassword({ redis_password: "rp" })).toBe("rp");
  });
});

describe("buildParamsFromBtDockerRedis", () => {
  it("emits PANEL_REDIS_* keys for importPanelAppToDatabase", () => {
    const app: BtInstalledApp = {
      id: "2",
      appid: 11,
      appname: "redis",
      apptitle: "Redis",
      service_name: "redis_main",
      container_id: "rd1",
      port: ["16379:6379"],
      appinfo: [
        { fieldKey: "redis_password", fieldTitle: "Password", fieldValue: "rp@ss" },
        { fieldKey: "redis_port", fieldTitle: "Port", fieldValue: "16379" },
      ],
    };
    const config = buildParamsFromBtDockerRedis(app);
    const byKey = Object.fromEntries(config.params.map((p) => [p.key, String(p.value ?? "")]));
    expect(byKey.PANEL_REDIS_PORT).toBe("16379");
    expect(byKey.PANEL_REDIS_ROOT_PASSWORD).toBe("rp@ss");
    expect(byKey.PANEL_DB_NAME).toBe("0");
    expect(config.containerName).toBe("rd1");
  });
});
