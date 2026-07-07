import { describe, expect, it } from "vitest";

import {
  parseSshConnectCommand,
  tokenizeShellCommand,
} from "./parseSshConnectCommand";

describe("tokenizeShellCommand", () => {
  it("保留引号内空格", () => {
    expect(tokenizeShellCommand('ssh "admin:pass@host" -p 2222')).toEqual([
      "ssh",
      "admin:pass@host",
      "-p",
      "2222",
    ]);
  });
});

describe("parseSshConnectCommand", () => {
  it("用户名可含冒号，不拆出密码", () => {
    expect(
      parseSshConnectCommand('ssh "admin:y-d2@w.protected.fun" -p 2222'),
    ).toEqual({
      user: "admin:y-d2",
      host: "w.protected.fun",
      port: 2222,
    });
  });

  it("解析 user@host", () => {
    expect(parseSshConnectCommand("ssh root@example.com")).toEqual({
      user: "root",
      host: "example.com",
      port: 22,
    });
  });

  it("解析选项顺序变化", () => {
    expect(parseSshConnectCommand("ssh -p 2222 admin@example.com")).toEqual({
      user: "admin",
      host: "example.com",
      port: 2222,
    });
  });

  it("解析 -l 与 -i", () => {
    expect(
      parseSshConnectCommand("ssh -l deploy -i ~/.ssh/id_ed25519 example.com"),
    ).toEqual({
      user: "deploy",
      host: "example.com",
      port: 22,
      identityFile: "~/.ssh/id_ed25519",
    });
  });

  it("忽略带远程命令的 ssh", () => {
    expect(parseSshConnectCommand("ssh host uptime")).toBeNull();
  });

  it("忽略跳板参数", () => {
    expect(parseSshConnectCommand("ssh -J jump host")).toBeNull();
  });

  it("忽略非 ssh 命令", () => {
    expect(parseSshConnectCommand("scp file host:")).toBeNull();
  });
});
