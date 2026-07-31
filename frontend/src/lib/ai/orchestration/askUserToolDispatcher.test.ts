import { describe, expect, it } from "vitest";
import {
  parseAskUserArgs,
  serializeAskUserResult,
  validateAskUserAnswers,
} from "./askUserSchema";

describe("parseAskUserArgs", () => {
  it("accepts a valid single_choice form", () => {
    const result = parseAskUserArgs(
      JSON.stringify({
        title: "环境",
        questions: [
          {
            id: "env",
            prompt: "部署到哪？",
            type: "single_choice",
            options: [
              { id: "dev", label: "开发" },
              { id: "prod", label: "生产" },
            ],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toBe("环境");
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]?.required).toBe(true);
  });

  it("rejects choice without enough options", () => {
    const result = parseAskUserArgs(
      JSON.stringify({
        questions: [
          {
            id: "env",
            prompt: "部署到哪？",
            type: "single_choice",
            options: [{ id: "dev", label: "开发" }],
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects more than 5 questions", () => {
    const questions = Array.from({ length: 6 }, (_, i) => ({
      id: `q${i}`,
      prompt: `题 ${i}`,
      type: "text",
    }));
    const result = parseAskUserArgs(JSON.stringify({ questions }));
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate question ids", () => {
    const result = parseAskUserArgs(
      JSON.stringify({
        questions: [
          { id: "a", prompt: "一", type: "text" },
          { id: "a", prompt: "二", type: "text" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("validateAskUserAnswers", () => {
  const questions = [
    {
      id: "env",
      prompt: "环境",
      type: "single_choice" as const,
      options: [
        { id: "dev", label: "开发" },
        { id: "prod", label: "生产" },
      ],
      required: true,
    },
    {
      id: "tags",
      prompt: "标签",
      type: "multi_choice" as const,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      required: true,
    },
    {
      id: "note",
      prompt: "备注",
      type: "text" as const,
      required: false,
    },
  ];

  it("requires single and multi choice answers", () => {
    expect(validateAskUserAnswers(questions, {})).toMatch(/环境/);
    expect(validateAskUserAnswers(questions, { env: "dev" })).toMatch(/标签/);
    expect(
      validateAskUserAnswers(questions, { env: "dev", tags: [] }),
    ).toMatch(/标签/);
  });

  it("passes when required fields are filled", () => {
    expect(
      validateAskUserAnswers(questions, { env: "prod", tags: ["a"] }),
    ).toBeNull();
  });
});

describe("serializeAskUserResult", () => {
  it("serializes answered payload", () => {
    const json = serializeAskUserResult("answered", { env: "prod", tags: ["a"] });
    expect(JSON.parse(json)).toEqual({
      ok: true,
      status: "answered",
      answers: { env: "prod", tags: ["a"] },
    });
  });

  it("serializes skipped payload", () => {
    const json = serializeAskUserResult("skipped");
    expect(JSON.parse(json)).toEqual({
      ok: true,
      status: "skipped",
      answers: {},
    });
  });
});
