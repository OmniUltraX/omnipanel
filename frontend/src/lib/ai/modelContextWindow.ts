/** 按模型名启发式推断上下文窗口（token）。无官方元数据时的合理默认。 */
export function resolveModelContextWindow(modelName: string | null | undefined): number {
  const name = (modelName ?? "").toLowerCase();
  if (!name) return 128_000;

  if (/(^|[-_/])(32k|32768)\b/.test(name)) return 32_768;
  if (/(^|[-_/])(16k|16384)\b/.test(name)) return 16_384;
  if (/(^|[-_/])(8k|8192)\b/.test(name)) return 8_192;
  if (/(^|[-_/])(4k|4096)\b/.test(name)) return 4_096;
  if (/(^|[-_/])(1m|1000k|1048576)\b/.test(name) || name.includes("gemini-1.5") || name.includes("gemini-2")) {
    return 1_000_000;
  }
  if (name.includes("claude") && (name.includes("sonnet") || name.includes("opus") || name.includes("haiku"))) {
    return 200_000;
  }
  if (name.includes("gpt-4.1") || name.includes("gpt-4o") || name.includes("o1") || name.includes("o3") || name.includes("o4")) {
    return 128_000;
  }
  if (name.includes("gpt-3.5")) return 16_384;
  if (name.includes("qwen") && (name.includes("long") || name.includes("plus") || name.includes("max") || name.includes("turbo"))) {
    return 131_072;
  }
  if (name.includes("deepseek")) return 128_000;
  if (name.includes("llama") && name.includes("70b")) return 128_000;

  return 128_000;
}

/** 粗估文本 token 数（中英混合场景下偏保守）。 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    } else if (!/\s/.test(ch)) {
      other += 1;
    }
  }
  return Math.max(1, Math.ceil(cjk * 1.5 + other / 4));
}
