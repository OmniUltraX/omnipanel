import type { ImportCandidate } from "@omnipanel/plugin-sdk";

export function candidateDedupeKey(item: ImportCandidate): string {
  return `${item.pluginId}\0${item.accountId ?? ""}\0${item.remoteId}`;
}

/** 按 (pluginId, accountId, remoteId) 去重，后来者覆盖。 */
export function upsertImportCandidates(
  existing: ImportCandidate[],
  incoming: ImportCandidate[],
): ImportCandidate[] {
  const out = [...existing];
  for (const item of incoming) {
    const key = candidateDedupeKey(item);
    const idx = out.findIndex((c) => candidateDedupeKey(c) === key);
    if (idx >= 0) out[idx] = item;
    else out.push(item);
  }
  return out;
}
