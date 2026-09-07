import { describe, expect, it } from "vitest";
import {
  BT_SOFT_MYSQL_FALLBACK_INSTALL_ID,
  buildParamsFromBtDockerMysql,
  btSoftMysqlInstallId,
  isBtMysqlOrMariadbKey,
  pickDockerMysqlPassword,
  pickDockerMysqlPort,
  pickDockerMysqlUser,
} from "./installedMysqlParams";
import type { BtInstalledApp } from "./types";

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

describe("docker mysql field pickers", () => {
  it("prefers host port from mapping", () => {
    const app = { port: ["3307:3306"] } as BtInstalledApp;
    expect(pickDockerMysqlPort(app, {})).toBe("3307");
  });

  it("reads password and user from appinfo map", () => {
    const map = {
      mysql_root_password: "s3cret",
      mysql_user: "admin",
    };
    expect(pickDockerMysqlPassword(map)).toBe("s3cret");
    expect(pickDockerMysqlUser(map)).toBe("admin");
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
