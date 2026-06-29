/**
 * OmniAgent 入口
 *
 *   npm start              # acp 模式（默认）
 *   npm run start:web      # web 模式（API + dev-ui）
 *
 * 结构:
 *   core/       — DeepAgents 运行时、会话、turn 逻辑
 *   adapters/   — acp（stdio）与 web（HTTP）传输适配器
 *   dev-ui/     — web 模式 assistant-ui 客户端
 */
import { pathToFileURL } from "node:url";

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryHref) {
  void import("./cli.js").then(({ runOmniAgent }) => runOmniAgent());
}
