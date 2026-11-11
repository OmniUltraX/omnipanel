import { describe, expect, it, beforeEach } from "vitest";
import {
  preparePtyBytesForXterm,
  resetShellHistorySyncFilterState,
  stripShellHistorySyncNoise,
  stripShellHistorySyncNoiseStateful,
} from "./shellHistoryOutputFilter";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("shellHistoryOutputFilter", () => {
  beforeEach(() => {
    resetShellHistorySyncFilterState();
  });

  it("strips begin/end markers from a single chunk", () => {
    const text = "prompt$\n__OMNIPANEL_HIST_BEGIN__\nabc123==\n__OMNIPANEL_HIST_END__\nnext$ ";
    expect(stripShellHistorySyncNoise(text)).not.toContain("__OMNIPANEL_HIST_BEGIN__");
    expect(stripShellHistorySyncNoise(text)).not.toContain("__OMNIPANEL_HIST_END__");
    expect(stripShellHistorySyncNoise(text)).toContain("prompt$");
    expect(stripShellHistorySyncNoise(text)).toContain("next$ ");
  });

  it("drops markers that arrive after the silent-sync window, across chunks", () => {
    const first = stripShellHistorySyncNoiseStateful(
      "s1",
      "echo hi\n__OMNIPANEL_HIST_BEGIN__\n",
    );
    const mid = stripShellHistorySyncNoiseStateful("s1", "QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ==\n");
    const last = stripShellHistorySyncNoiseStateful("s1", "__OMNIPANEL_HIST_END__\n$ ");
    expect(first).toContain("echo hi");
    expect(first).not.toContain("__OMNIPANEL_HIST_BEGIN__");
    expect(mid).toBe("");
    expect(last).toContain("$ ");
    expect(last).not.toContain("__OMNIPANEL_HIST_END__");
  });

  it("prepares xterm bytes without leaking markers", () => {
    const bytes = encoder.encode("x\n__OMNIPANEL_HIST_BEGIN__\n__OMNIPANEL_HIST_END__\ny\n");
    const out = preparePtyBytesForXterm("pty-1", bytes);
    const text = decoder.decode(out);
    expect(text).toContain("x");
    expect(text).toContain("y");
    expect(text).not.toContain("__OMNIPANEL_HIST_");
  });
});
