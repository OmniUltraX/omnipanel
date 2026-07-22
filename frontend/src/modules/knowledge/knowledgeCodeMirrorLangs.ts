import { languages as allLanguages } from "@codemirror/language-data";
import type { LanguageDescription } from "@codemirror/language";

/**
 * Crepe 默认挂载 @codemirror/language-data 全量语言（上百种），
 * 文档里多个代码块同时高亮时非常卡。知识库只保留常用语言。
 */
const ALLOWED_LANGUAGE_NAMES = new Set([
  "SQL",
  "JavaScript",
  "TypeScript",
  "TSX",
  "JSX",
  "JSON",
  "JSON with Comments",
  "Python",
  "HTML",
  "CSS",
  "Markdown",
  "YAML",
  "XML",
  "Shell",
  "PowerShell",
  "Java",
  "Go",
  "Rust",
  "C",
  "C++",
  "C#",
  "PHP",
  "Ruby",
  "Kotlin",
  "Swift",
  "Dockerfile",
  "TOML",
  "Diff",
  "Plain Text",
]);

let cached: LanguageDescription[] | null = null;

export function getKnowledgeCodeMirrorLanguages(): LanguageDescription[] {
  if (cached) return cached;
  cached = allLanguages.filter((lang) => ALLOWED_LANGUAGE_NAMES.has(lang.name));
  return cached;
}
