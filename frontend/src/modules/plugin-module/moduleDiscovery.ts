import { commands } from "../../ipc/bindings";
import type { DiscoveryPreviewRow } from "../../components/ui/DiscoveryImportDialog";
import { unwrapCommand } from "../../ipc/result";
import { manifestModuleProbe } from "../../lib/moduleCapabilities";
import { listPluginManifests } from "../../lib/pluginManifests";
import { isPluginActivated } from "../../stores/pluginRuntimeStore";
import { useConnectionStore } from "../../stores/connectionStore";
import type { DiscoveryCandidates, DiscoveryProbeContext } from "../../lib/discoveryBus";
import {
  buildServiceCandidate,
  isDuplicateService,
  serviceRemoteId,
} from "./serviceDedupe";

export { buildServiceCandidate, isDuplicateService, serviceRemoteId } from "./serviceDedupe";

export async function probeModuleHttpCandidates(
  _scope: unknown,
  ctx?: DiscoveryProbeContext,
): Promise<DiscoveryCandidates> {
  const connections = useConnectionStore.getState().connections;
  const rows: DiscoveryPreviewRow[] = [];
  const errors: string[] = [];

  for (const manifest of listPluginManifests("module")) {
    if (ctx?.isCancelled()) break;
    if (!isPluginActivated(manifest.id)) continue;
    const usesHttpProbe = (manifest.contributes.discovery ?? []).some(
      (item) => item.probeId === "module-http",
    );
    if (!usesHttpProbe) continue;
    const probe = manifestModuleProbe(manifest);
    const ports = probe?.ports ?? [];
    if (ports.length === 0) continue;
    const contextPath = probe?.contextPath;
    for (const port of ports) {
      if (ctx?.isCancelled()) break;
      const host = "127.0.0.1";
      try {
        const result = (await unwrapCommand(
          commands.pluginInvoke(manifest.id, "probeHealth", {
            host,
            port,
            contextPath,
          } as never),
        )) as { ok?: boolean };
        if (result?.ok === false) continue;
        const candidate = buildServiceCandidate(manifest.id, host, port, {
          contextPath,
        });
        const duplicate = isDuplicateService(connections, manifest.id, host, port);
        rows.push({
          id: `${manifest.id}:${host}:${port}`,
          candidate,
          label: manifest.contributes.ui?.moduleKey || manifest.id,
          kindLabel: "service",
          host: serviceRemoteId(host, port),
          status: duplicate ? "duplicate" : "importable",
          disabled: duplicate,
        });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return { probeId: "module-http", rows, errors };
}

export async function importModuleServiceRows(
  selected: DiscoveryPreviewRow[],
): Promise<{ added: number; skipped: number }> {
  const save = useConnectionStore.getState().save;
  let added = 0;
  let skipped = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const row of selected) {
    if (row.status !== "importable") {
      skipped += 1;
      continue;
    }
    const cfg = (row.candidate.config ?? {}) as Record<string, unknown>;
    const pluginId = row.candidate.pluginId;
    const existing = useConnectionStore.getState().connections;
    if (
      isDuplicateService(
        existing,
        pluginId,
        String(cfg.host ?? ""),
        Number(cfg.port ?? 0),
      )
    ) {
      skipped += 1;
      continue;
    }
    const saved = await save({
      id: "",
      kind: "service",
      name: row.label,
      group: "",
      envTag: "dev",
      tags: [],
      config: JSON.stringify({
        pluginId,
        host: cfg.host,
        port: cfg.port,
        contextPath: cfg.contextPath,
        externalSource: {
          pluginId,
          remoteId: row.candidate.remoteId,
          remoteKind: "service",
        },
      }),
      createdAt: now,
      updatedAt: now,
    });
    if (saved) added += 1;
    else skipped += 1;
  }
  return { added, skipped };
}

