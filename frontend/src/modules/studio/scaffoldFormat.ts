/**
 * AI 脚手架输出解析：三段围栏代码块 → { plugin.json, ui/main.js, ui/index.html }。
 * 纯函数，零依赖（单测友好；StudioPanel 与测试共用）。
 */
export function extractFencedBlocks(output: string): Record<string, string> {
  const found: Record<string, string> = {};
  const re = /```([\w./-]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(output)) !== null) {
    const tag = match[1].trim().toLowerCase();
    const body = match[2].replace(/^\n+/, "").replace(/\s+$/, "");
    if (tag.includes("plugin.json") || tag === "json") found["plugin.json"] = body;
    else if (tag.includes("main.js") || tag === "js" || tag === "javascript")
      found["ui/main.js"] = body;
    else if (tag.includes("index.html") || tag === "html") found["ui/index.html"] = body;
  }
  return found;
}
