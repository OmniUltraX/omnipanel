import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYNC_STUN_URL,
  getSyncKeyP2pIceServers,
  resolveSyncStunUrls,
} from "./syncP2pConfig";

describe("syncP2pConfig", () => {
  it("defaults to production STUN server", () => {
    expect(DEFAULT_SYNC_STUN_URL).toBe("stun:1.99.protected.fun:3478");
    expect(resolveSyncStunUrls()).toEqual([DEFAULT_SYNC_STUN_URL]);
    expect(getSyncKeyP2pIceServers()).toEqual([
      { urls: DEFAULT_SYNC_STUN_URL },
    ]);
  });
});
