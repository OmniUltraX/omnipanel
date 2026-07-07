import { describe, expect, it } from "vitest";
import {
  isIncompleteAtEndParseError,
  shouldSuppressParseErrorWhileTyping,
} from "./incompleteParseError";

describe("incompleteParseError", () => {
  it("detects end-of-input parser messages", () => {
    expect(
      isIncompleteAtEndParseError(
        'Expected "`" but end of input found.',
      ),
    ).toBe(true);
  });

  it("does not treat unrelated parse errors as incomplete", () => {
    expect(isIncompleteAtEndParseError("Unknown column 'x'")).toBe(false);
  });

  it("suppresses incomplete parse errors while cursor stays in the statement", () => {
    const message = "Expected identifier but end of input found.";
    expect(shouldSuppressParseErrorWhileTyping(message, 28, 0, 28)).toBe(true);
  });

  it("keeps incomplete parse errors when cursor moved to another statement", () => {
    const message = "Expected identifier but end of input found.";
    expect(shouldSuppressParseErrorWhileTyping(message, 40, 0, 28)).toBe(false);
  });
});
