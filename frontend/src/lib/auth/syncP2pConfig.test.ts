import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYNC_STUN_URL,
  getSyncKeyP2pIceServers,
  resolveSyncStunUrls,
} from "./syncP2pConfig";

describe("syncP2pConfig", () => {
  it("defaults to no STUN when env is unset", () => {
    expect(DEFAULT_SYNC_STUN_URL).toBe("");
    expect(resolveSyncStunUrls()).toEqual([]);
    expect(getSyncKeyP2pIceServers()).toEqual([]);
  });
});
