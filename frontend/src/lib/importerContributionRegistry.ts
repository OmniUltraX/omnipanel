import type { ImportCandidate } from "@omnipanel/plugin-sdk";

/** 导入器贡献（向导预览数据源）由插件经 Runtime Loader 登记。 */
export type ImporterContribution = {
  /** 与 manifest `contributes.importers[].id` 对齐。 */
  id: string;
  pluginId: string;
  /** 由 token/凭据产出预览候选；远程拉取落地前允许返回示例数据。 */
  getPreviewCandidates: (token: string) => ImportCandidate[];
  /** 预览数据是否为示例（诚实标注，不冒充已拉取）。 */
  sampleOnly: boolean;
};

const contributions = new Map<string, ImporterContribution>();

export function registerImporterContribution(contribution: ImporterContribution): void {
  contributions.set(contribution.id, contribution);
}

export function unregisterImporterContributions(pluginId: string): void {
  for (const [id, item] of contributions) {
    if (item.pluginId === pluginId) contributions.delete(id);
  }
}

export function getImporterContribution(id: string): ImporterContribution | null {
  return contributions.get(id) ?? null;
}
