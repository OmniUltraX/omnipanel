import { beforeEach, describe, expect, it } from "vitest";
import {
  resetTerminalBackendStateStore,
  useTerminalBackendStateStore,
} from "./terminalBackendStateStore";

describe("terminalBackendStateStore", () => {
  beforeEach(() => {
    resetTerminalBackendStateStore();
  });

  describe("pending sessions", () => {
    it("setPendingSession stores and getPendingSession retrieves", () => {
      const p = Promise.resolve("sid-1");
      useTerminalBackendStateStore.getState().setPendingSession("s1", p);

      expect(useTerminalBackendStateStore.getState().getPendingSession("s1")).toBe(p);
      expect(useTerminalBackendStateStore.getState().getPendingSession("missing")).toBeUndefined();
    });

    it("clearPendingSession removes the entry", () => {
      useTerminalBackendStateStore.getState().setPendingSession("s1", Promise.resolve("x"));
      useTerminalBackendStateStore.getState().clearPendingSession("s1");

      expect(useTerminalBackendStateStore.getState().getPendingSession("s1")).toBeUndefined();
    });

    it("clearPendingSession is a no-op for unknown pane", () => {
      const before = useTerminalBackendStateStore.getState();
      useTerminalBackendStateStore.getState().clearPendingSession("unknown");
      // state reference unchanged when nothing removed
      expect(useTerminalBackendStateStore.getState()).toBe(before);
    });

    it("clearSessionRuntime clears pending for the session", () => {
      useTerminalBackendStateStore.getState().setPendingSession("s1", Promise.resolve("x"));
      useTerminalBackendStateStore.getState().clearSessionRuntime("s1");

      expect(useTerminalBackendStateStore.getState().getPendingSession("s1")).toBeUndefined();
    });
  });

  describe("injected sessions", () => {
    it("addInjectedSession marks a backend sid as injected", () => {
      expect(useTerminalBackendStateStore.getState().hasInjectedSession("ssh-1")).toBe(false);

      useTerminalBackendStateStore.getState().addInjectedSession("ssh-1");

      expect(useTerminalBackendStateStore.getState().hasInjectedSession("ssh-1")).toBe(true);
    });

    it("removeInjectedSession clears the mark", () => {
      useTerminalBackendStateStore.getState().addInjectedSession("ssh-1");
      useTerminalBackendStateStore.getState().removeInjectedSession("ssh-1");

      expect(useTerminalBackendStateStore.getState().hasInjectedSession("ssh-1")).toBe(false);
    });

    it("addInjectedSession is idempotent (no state churn when already present)", () => {
      useTerminalBackendStateStore.getState().addInjectedSession("ssh-1");
      const before = useTerminalBackendStateStore.getState();

      useTerminalBackendStateStore.getState().addInjectedSession("ssh-1");
      expect(useTerminalBackendStateStore.getState()).toBe(before);
    });

    it("removeInjectedSession is a no-op for unknown sid", () => {
      const before = useTerminalBackendStateStore.getState();
      useTerminalBackendStateStore.getState().removeInjectedSession("unknown");
      expect(useTerminalBackendStateStore.getState()).toBe(before);
    });
  });

  describe("clearAll / resetTerminalBackendStateStore", () => {
    it("clears both pending and injected state", () => {
      useTerminalBackendStateStore.getState().setPendingSession("s1", Promise.resolve("x"));
      useTerminalBackendStateStore.getState().addInjectedSession("ssh-1");

      useTerminalBackendStateStore.getState().clearAll();

      expect(useTerminalBackendStateStore.getState().getPendingSession("s1")).toBeUndefined();
      expect(useTerminalBackendStateStore.getState().hasInjectedSession("ssh-1")).toBe(false);
    });

    it("resetTerminalBackendStateStore delegates to clearAll", () => {
      useTerminalBackendStateStore.getState().setPendingSession("s1", Promise.resolve("x"));
      useTerminalBackendStateStore.getState().addInjectedSession("ssh-1");

      resetTerminalBackendStateStore();

      expect(useTerminalBackendStateStore.getState().getPendingSession("s1")).toBeUndefined();
      expect(useTerminalBackendStateStore.getState().hasInjectedSession("ssh-1")).toBe(false);
    });
  });
});
