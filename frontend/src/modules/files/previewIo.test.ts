import { describe, expect, it } from "vitest";
import { LOCAL_CONNECTION_ID } from "./utils";
import { previewIoSessionFromTarget } from "./previewIo";

describe("previewIoSessionFromTarget", () => {
  it("maps remote+resourceId to sftp", () => {
    expect(
      previewIoSessionFromTarget({
        sessionType: "remote",
        connectionId: "conn",
        resourceId: "ssh-1",
      }),
    ).toEqual({ kind: "sftp", connectionId: "conn", resourceId: "ssh-1" });
  });

  it("maps local to local", () => {
    expect(
      previewIoSessionFromTarget({
        sessionType: "local",
        connectionId: LOCAL_CONNECTION_ID,
      }),
    ).toEqual({ kind: "local", connectionId: LOCAL_CONNECTION_ID });
  });

  it("maps file_manager connection without resource", () => {
    expect(
      previewIoSessionFromTarget({
        sessionType: "remote",
        connectionId: "file-conn-1",
        resourceId: null,
      }),
    ).toEqual({ kind: "file_manager", connectionId: "file-conn-1" });
  });
});
