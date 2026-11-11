import { describe, expect, it, beforeEach } from "vitest";
import { publishModuleStatusLog, clearModuleStatusLog } from "./moduleStatusLog";
import { useStatusBarLogStore } from "../stores/statusBarLogStore";

describe("publishModuleStatusLog", () => {
  beforeEach(() => {
    useStatusBarLogStore.setState({ activePublisher: "ssh", logsByModule: {} });
    clearModuleStatusLog("database");
  });

  it("records completion even when the module is not the active publisher", () => {
    publishModuleStatusLog("database", "正在刷新 Schema 缓存…", "progress");
    publishModuleStatusLog("database", "Schema 缓存已刷新", "success");
    expect(useStatusBarLogStore.getState().logsByModule.database?.message).toBe(
      "Schema 缓存已刷新",
    );
    expect(useStatusBarLogStore.getState().logsByModule.database?.level).toBe("success");
  });
});
