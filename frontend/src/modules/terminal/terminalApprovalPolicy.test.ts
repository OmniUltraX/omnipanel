import { afterEach, describe, expect, it, vi } from "vitest";

const permanentWhitelist: string[] = [];

vi.mock("../../stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      terminalCommandWhitelist: permanentWhitelist,
      setTerminalCommandWhitelist: (keys: string[]) => {
        permanentWhitelist.length = 0;
        permanentWhitelist.push(...keys);
      },
    }),
  },
}));

import {
  isReadOnlyTerminalCommand,
  shouldRequireTerminalApproval,
  stripHarmlessRedirects,
} from "./terminalApprovalPolicy";
import {
  addPermanentCommandWhitelist,
  addSessionCommandWhitelist,
  clearSessionCommandWhitelist,
  formatCommandWhitelistLabel,
  isCommandWhitelisted,
} from "./terminalCommandWhitelist";

describe("isReadOnlyTerminalCommand", () => {
  it("treats du with stderr to /dev/null and pipes as read-only", () => {
    const cmd = "du -h --max-depth=1 /root 2>/dev/null | sort -hr | head -20";
    expect(stripHarmlessRedirects(cmd)).toBe(
      "du -h --max-depth=1 /root | sort -hr | head -20",
    );
    expect(isReadOnlyTerminalCommand(cmd)).toBe(true);
    expect(shouldRequireTerminalApproval(cmd, "view")).toBe(false);
  });

  it("ignores 2>&1 fd duplication", () => {
    expect(isReadOnlyTerminalCommand("ps aux 2>&1 | head -20")).toBe(true);
    expect(shouldRequireTerminalApproval("ps aux 2>&1 | head -20", "view")).toBe(false);
  });

  it("still flags real file redirects as writes", () => {
    expect(isReadOnlyTerminalCommand("echo hi > /tmp/out.txt")).toBe(false);
    expect(shouldRequireTerminalApproval("echo hi > /tmp/out.txt", "view")).toBe(true);
  });

  it("requires approval for mutating commands in view mode", () => {
    expect(shouldRequireTerminalApproval("rm -rf /tmp/x", "view")).toBe(true);
    expect(shouldRequireTerminalApproval("docker restart web", "view")).toBe(true);
  });

  it("always requires approval in strict mode unless whitelisted", () => {
    expect(shouldRequireTerminalApproval("ls -la", "strict")).toBe(true);
    expect(shouldRequireTerminalApproval("ls -la", "loose")).toBe(false);
  });
});

describe("terminal command whitelist", () => {
  afterEach(() => {
    clearSessionCommandWhitelist();
    permanentWhitelist.length = 0;
  });

  it("formats primary command label", () => {
    expect(formatCommandWhitelistLabel("du -h /root 2>/dev/null")).toBe("du");
    expect(formatCommandWhitelistLabel("docker restart api")).toBe("docker restart");
  });

  it("scopes session whitelist to AI / terminal session", () => {
    const cmd = "npm install lodash";
    const scopeA = { conversationId: "conv-a", terminalSessionId: "term-1" };
    const scopeB = { conversationId: "conv-b", terminalSessionId: "term-2" };

    expect(shouldRequireTerminalApproval(cmd, "view", scopeA)).toBe(true);
    addSessionCommandWhitelist(cmd, scopeA);
    expect(isCommandWhitelisted(cmd, scopeA)).toBe(true);
    expect(shouldRequireTerminalApproval(cmd, "view", scopeA)).toBe(false);
    expect(shouldRequireTerminalApproval("npm install react", "strict", scopeA)).toBe(false);
    // 其它 AI/终端会话仍需审批
    expect(shouldRequireTerminalApproval(cmd, "view", scopeB)).toBe(true);
  });

  it("persists permanent whitelist keys", () => {
    addPermanentCommandWhitelist("docker restart api");
    expect(permanentWhitelist).toContain("docker restart");
    expect(shouldRequireTerminalApproval("docker restart other", "strict")).toBe(false);
  });
});
