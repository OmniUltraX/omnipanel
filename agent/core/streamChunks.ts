import { AIMessageChunk } from "@langchain/core/messages";

/** 从 LangChain 流式 chunk 提取正文与思考内容。 */
export function extractStreamChunkParts(chunk: AIMessageChunk): {
  text: string;
  reasoning: string;
} {
  let text = "";
  let reasoning = "";

  const content = chunk.content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") {
        text += part;
        continue;
      }
      if (!part || typeof part !== "object" || !("type" in part)) continue;
      if (part.type === "text" && "text" in part && typeof part.text === "string") {
        text += part.text;
      } else if (
        part.type === "reasoning" &&
        "reasoning" in part &&
        typeof part.reasoning === "string"
      ) {
        reasoning += part.reasoning;
      }
    }
  }

  const reasoningContent = chunk.additional_kwargs?.reasoning_content;
  if (typeof reasoningContent === "string") {
    reasoning += reasoningContent;
  }

  return { text, reasoning };
}
