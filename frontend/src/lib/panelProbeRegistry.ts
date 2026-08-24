import type { ImportCandidate } from "@omnipanel/plugin-sdk";

/** 面板探测 kind → 插件 candidate 映射器（由插件经 Runtime Loader 登记）。 */
export type PanelProbeMapper = {
  pluginId: string;
  claims: (kind: string | null | undefined) => boolean;
  toCandidate: (input: {
    sshId: string;
    sshName: string;
    address: string;
    apiKey?: string;
    apiEnabled: boolean;
  }) => ImportCandidate;
};

const mappers: PanelProbeMapper[] = [];

export function registerPanelProbeMapper(mapper: PanelProbeMapper): void {
  const idx = mappers.findIndex((m) => m.pluginId === mapper.pluginId);
  if (idx >= 0) mappers[idx] = mapper;
  else mappers.push(mapper);
}

export function unregisterPanelProbeMappers(pluginId: string): void {
  const idx = mappers.findIndex((m) => m.pluginId === pluginId);
  if (idx >= 0) mappers.splice(idx, 1);
}

export function findPanelProbeMapper(
  kind: string,
): Pick<PanelProbeMapper, "pluginId" | "toCandidate"> | null {
  return mappers.find((m) => m.claims(kind)) ?? null;
}
