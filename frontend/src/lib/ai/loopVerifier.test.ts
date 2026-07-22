import { describe, expect, it } from "vitest";
import type { LoopFinding, LoopRun, LoopSpec } from "./loopSpec";
import { shouldStopLoop, verifyLoopRun } from "./loopVerifier";

function baseSpec(over: Partial<LoopSpec> = {}): LoopSpec {
  return {
    id: "t",
    name: "t",
    description: "",
    trigger: "manual",
    worker: {},
    verify: { mode: "deterministic", maxOpenFindings: 0 },
    stop: { maxTurns: 3, verifyPass: true },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function baseRun(over: Partial<LoopRun> = {}): LoopRun {
  return {
    id: "r",
    loopId: "t",
    status: "verifying",
    startedAt: 1,
    turns: [],
    findingIds: [],
    ...over,
  };
}

describe("verifyLoopRun", () => {
  it("fails when critical findings remain open", () => {
    const findings: LoopFinding[] = [
      {
        id: "f1",
        loopId: "t",
        runId: "r",
        title: "x",
        summary: "y",
        severity: "critical",
        status: "open",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const r = verifyLoopRun({
      spec: baseSpec({ verify: { mode: "deterministic", maxOpenFindings: 5 } }),
      run: baseRun(),
      findings,
    });
    expect(r.passed).toBe(false);
  });

  it("passes when open findings within budget", () => {
    const findings: LoopFinding[] = [
      {
        id: "f1",
        loopId: "t",
        runId: "r",
        title: "x",
        summary: "y",
        severity: "info",
        status: "open",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const r = verifyLoopRun({
      spec: baseSpec({ verify: { mode: "deterministic", maxOpenFindings: 5 } }),
      run: baseRun(),
      findings,
    });
    expect(r.passed).toBe(true);
  });

  it("model mode still uses deterministic gate (no worker self-grade)", () => {
    const r = verifyLoopRun({
      spec: baseSpec({
        verify: {
          mode: "model",
          maxOpenFindings: 0,
          modelPrompt: "check no writes",
        },
      }),
      run: baseRun(),
      findings: [],
    });
    expect(r.passed).toBe(true);
    expect(r.mode).toBe("model");
  });
});

describe("shouldStopLoop", () => {
  it("stops on verifyPass", () => {
    expect(
      shouldStopLoop(baseSpec(), baseRun(), {
        passed: true,
        reason: "ok",
        mode: "deterministic",
      }),
    ).toBe(true);
  });

  it("stops on maxTurns", () => {
    const run = baseRun({
      turns: [
        { index: 0, phase: "discover", summary: "", ok: true, at: 1 },
        { index: 1, phase: "verify", summary: "", ok: false, at: 2 },
        { index: 2, phase: "work", summary: "", ok: true, at: 3 },
      ],
    });
    expect(
      shouldStopLoop(baseSpec({ stop: { maxTurns: 3 } }), run, {
        passed: false,
        reason: "x",
        mode: "deterministic",
      }),
    ).toBe(true);
  });
});
