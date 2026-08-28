/**
 * 第三方 importer 示例：不向宿主 TS 登记贡献。
 * 宿主只读 plugin.json 的 `contributes.importers[]`，拉取走 L2 `logic.js`。
 * 本模块仅导出目标映射，供单测约束「连接 host = 堡垒，禁止内网 IP」。
 */
export { MOCK_WARPGATE_TARGETS, targetsToCandidates, WARPGATE_PLUGIN_ID } from "./mapTargets";
