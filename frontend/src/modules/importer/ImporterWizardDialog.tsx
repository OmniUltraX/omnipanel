import { useCallback, useEffect, useMemo, useState } from "react";
import type { ImportCandidate, ImporterContribution, ImporterField } from "@omnipanel/plugin-sdk";
import { FormDialog } from "@omnipanel/plugin-ui";
import { PasswordInput } from "../../components/ui/form/PasswordInput";
import { TextInput } from "@omnipanel/plugin-ui";
import { ImportPreview } from "@omnipanel/plugin-ui";
import { Select } from "../../components/ui/form/Select";
import { ResourceTagEditor } from "../../components/ui/tags/ResourceTagEditor";
import { IconSettings } from "../../components/ui/icons/Icons";
import { formatResourceTag } from "../../lib/resourceTags";
import { useI18n } from "../../i18n";
import { createPluginHost } from "../../lib/pluginHost";
import { upsertImportCandidates } from "../../lib/importCandidates";
import { findImporter, resolveImporterText, secretKeyFor } from "../../lib/importerCatalog";
import {
  collectImportGroupSuggestions,
  defaultImportGroups,
  groupForImporter,
  listSidebarFolderPaths,
  mergeImportGroups,
  resolveImportGroupFields,
  sanitizeImportGroupInput,
  type ImportGroupDest,
} from "../../lib/importGroups";
import { isPluginActivated } from "../../stores/pluginRuntimeStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDbSchemaConnectionLayoutStore } from "../../stores/dbSchemaConnectionLayoutStore";
import { useSshSidebarTreeStore } from "../../stores/sshSidebarTreeStore";
import { commands, type DockerConnectionInfo, type SshKeyInfo } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { scanDockerDatabases } from "../../lib/dockerDbScan";
import {
  deleteImporterSource,
  loadImporterState,
  readImporterSecret,
  upsertImporterSource,
  type ImporterAuthMode,
  type ImporterSource,
} from "../../lib/importerSources";

let openHandler: ((pluginId: string, importerId: string) => void) | null = null;

export function openImporter(pluginId: string, importerId: string): void {
  openHandler?.(pluginId, importerId);
}

export function registerImporterOpener(fn: ((pluginId: string, importerId: string) => void) | null): void {
  openHandler = fn;
}

type RightPane = "edit" | "resources";

function defaultTagFor(importer: ImporterContribution): string {
  return formatResourceTag("custom", importer.defaultTag?.trim() || importer.id);
}

function withDefaultTags(importer: ImporterContribution, tags: string[]): string[] {
  const locked = defaultTagFor(importer);
  return [locked, ...tags.filter((tag) => tag !== locked)];
}

function emptyValues(fields: ImporterField[]): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [
      field.key,
      field.kind === "checkbox" ? (field.defaultValue ?? "false") : (field.defaultValue ?? ""),
    ]),
  );
}

function isChecked(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function fetchStatusMessage(
  translate: (key: string, params?: Record<string, string | number>) => string,
  loaded: number,
  skipped: number,
): string {
  if (loaded === 0 && skipped === 0) return translate("plugins.importer.loadedEmpty");
  if (skipped > 0) {
    return translate("plugins.importer.loadedRemoteSkipped", { count: loaded, skipped });
  }
  return translate("plugins.importer.loadedRemote", { count: loaded });
}

export function ImporterWizardDialog() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pluginId, setPluginId] = useState("");
  const [importerId, setImporterId] = useState("");
  const [sources, setSources] = useState<ImporterSource[]>([]);
  const [dockerConnections, setDockerConnections] = useState<DockerConnectionInfo[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pane, setPane] = useState<RightPane>("edit");
  const [values, setValues] = useState<Record<string, string>>({});
  const [authMode, setAuthMode] = useState<ImporterAuthMode>("password");
  const [keyId, setKeyId] = useState("");
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [importGroups, setImportGroups] = useState<Record<string, string>>({});
  const [importTags, setImportTags] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "info" | "success" | "error"; message: string } | null>(
    null,
  );

  const active = useMemo(() => findImporter(pluginId, importerId), [pluginId, importerId]);
  const importer = active?.importer;
  const dockerMode = (importer?.sourceKind ?? "instances") === "dockerConnections";
  const fields = importer?.fields ?? [];
  const defaultGroup = importer?.defaultGroup?.trim() || "默认";
  const lockedTag = importer ? defaultTagFor(importer) : "";

  const connections = useConnectionStore((s) => s.connections);
  const dbTreeFolders = useDbSchemaConnectionLayoutStore((s) => s.folders);
  const sshTreeFolders = useSshSidebarTreeStore((s) => s.folders);
  const groupFields = useMemo(
    () =>
      resolveImportGroupFields({
        sourceKind: importer?.sourceKind,
        resourceKinds: importer?.resourceKinds,
        candidateKinds: candidates.map((item) => item.remoteKind),
      }),
    [candidates, importer],
  );
  const groupOptionsByDest = useMemo(() => {
    const byKind = (kind: string) => connections.filter((conn) => conn.kind === kind).map((conn) => conn.group);
    return {
      ssh: listSidebarFolderPaths(sshTreeFolders),
      database: listSidebarFolderPaths(dbTreeFolders),
      docker: collectImportGroupSuggestions(byKind("docker")),
      panel: collectImportGroupSuggestions(byKind("panel")),
    } satisfies Record<ImportGroupDest, string[]>;
  }, [connections, dbTreeFolders, sshTreeFolders]);

  useEffect(() => {
    const defaults = defaultImportGroups(groupFields, { defaultGroup });
    setImportGroups((prev) => mergeImportGroups(prev, groupFields, defaults));
  }, [defaultGroup, groupFields]);

  const groupKindLabel = (kind: string) => {
    const key = `plugins.importer.groupKinds.${kind}`;
    const label = t(key);
    return label === key ? kind : label;
  };
  const keyOptions = useMemo(() => {
    const options = keys.map((key) => ({
      value: key.id,
      label: key.name,
      subtitle: [key.keyType, key.fingerprint].filter(Boolean).join(" · "),
    }));
    if (keyId && !keys.some((key) => key.id === keyId)) {
      options.push({
        value: keyId,
        label: keyId,
        subtitle: t("ssh.dialog.keyMissingHint"),
      });
    }
    return options;
  }, [keyId, keys, t]);

  const applyImportMeta = useCallback(
    (item: ImportCandidate, source?: ImporterSource): ImportCandidate => {
      const useForm = !source || source.id === editingId;
      const mode = useForm ? authMode : source.authMode ?? "password";
      const selectedKey = (useForm ? keyId : source.keyId ?? "").trim();
      const prev =
        item.config && typeof item.config === "object" && !Array.isArray(item.config)
          ? { ...(item.config as Record<string, unknown>) }
          : {};
      prev.importGroup = groupForImporter(importer, importGroups, item.remoteKind);
      prev.importTags = importer ? withDefaultTags(importer, importTags) : importTags;
      if (mode === "key" && selectedKey) {
        prev.keyId = selectedKey;
        delete prev.password;
      } else {
        delete prev.keyId;
      }
      return { ...item, config: prev };
    },
    [authMode, editingId, importGroups, importTags, importer, keyId],
  );

  const refreshSources = useCallback(async () => {
    if (!pluginId) return [];
    const state = await loadImporterState(pluginId);
    setSources(state.sources);
    return state.sources;
  }, [pluginId]);

  const resetEditor = () => {
    setEditingId(null);
    setValues(emptyValues(fields));
    setAuthMode("password");
    setKeyId("");
    setCandidates([]);
    setSelectedIds(new Set());
    setSettingsOpen(false);
    setPane(dockerMode ? "resources" : "edit");
  };

  const applySource = (source: ImporterSource, nextPane: RightPane) => {
    setEditingId(source.id);
    setValues({
      ...emptyValues(fields),
      ...source.values,
      name: source.name,
    });
    setAuthMode(source.authMode === "key" ? "key" : "password");
    setKeyId(source.keyId ?? "");
    setSettingsOpen(false);
    setPane(nextPane);
    if (nextPane === "edit") {
      setCandidates([]);
      setSelectedIds(new Set());
    }
  };

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const res = await commands.sshListKeys();
      if (res.status === "ok") setKeys(res.data);
    })();
  }, [open]);

  useEffect(() => {
    registerImporterOpener((nextPluginId, nextImporterId) => {
      setPluginId(nextPluginId);
      setImporterId(nextImporterId);
      setOpen(true);
      setStatus(null);
      setCandidates([]);
      setSelectedIds(new Set());
      setSettingsOpen(false);
      const found = findImporter(nextPluginId, nextImporterId);
      const nextDocker = (found?.importer.sourceKind ?? "instances") === "dockerConnections";
      const fields = resolveImportGroupFields({
        sourceKind: found?.importer.sourceKind,
        resourceKinds: found?.importer.resourceKinds,
      });
      setImportGroups(
        defaultImportGroups(fields, {
          defaultGroup: found?.importer.defaultGroup?.trim() || "",
        }),
      );
      setImportTags(found ? withDefaultTags(found.importer, []) : []);
      setValues(emptyValues(found?.importer.fields ?? []));
      setAuthMode("password");
      setKeyId("");
      if (nextDocker) {
        setSources([]);
        setPane("resources");
        void unwrapCommand(commands.dockerListConnections())
          .then((list) => {
            setDockerConnections(list);
            if (list[0]) {
              setEditingId(list[0].connectionId);
              setSelectedSourceIds((prev) => (prev.size > 0 ? prev : new Set([list[0].connectionId])));
            } else {
              setEditingId(null);
              setSelectedSourceIds(new Set());
            }
          })
          .catch(() => {
            setDockerConnections([]);
            setEditingId(null);
            setSelectedSourceIds(new Set());
          });
        return;
      }
      setDockerConnections([]);
      void loadImporterState(nextPluginId).then((state) => {
        setSources(state.sources);
        if (state.sources[0]) {
          const source = state.sources[0];
          setEditingId(source.id);
          setValues({
            ...emptyValues(found?.importer.fields ?? []),
            ...source.values,
            name: source.name,
          });
          setAuthMode(source.authMode === "key" ? "key" : "password");
          setKeyId(source.keyId ?? "");
          setPane("resources");
          setSelectedSourceIds((prev) => (prev.size > 0 ? prev : new Set([source.id])));
        } else {
          setEditingId(null);
          setPane("edit");
        }
      });
    });
    return () => registerImporterOpener(null);
  }, []);

  const fetchFrom = async (
    source: ImporterSource | undefined,
    fieldValues: Record<string, string>,
  ): Promise<{ candidates: ImportCandidate[]; loginUser: string; skipped: number }> => {
    if (!importer || !isPluginActivated(pluginId) || !importer.fetchMethod) {
      throw new Error(t("plugins.importer.contributionMissing"));
    }
    const args: Record<string, unknown> = { ...fieldValues };
    args.pluginId = pluginId;
    args.accountId = source?.id;
    args.sourceId = source?.id;
    for (const field of fields) {
      if (field.kind === "checkbox") {
        args[field.key] = isChecked(fieldValues[field.key]);
        continue;
      }
      if (field.kind !== "secret") continue;
      args[`${field.key}Key`] = source ? secretKeyFor(field, source.id) : undefined;
      if (!String(args[field.key] ?? "").trim() && source) {
        args[field.key] = await readImporterSecret(pluginId, source, field.key);
      }
    }
    const result = await unwrapCommand(
      commands.pluginInvoke(pluginId, importer.fetchMethod, args as never),
    );
    const payload = result as {
      targets?: ImportCandidate[];
      loginUser?: string;
      skipped?: unknown[];
    };
    return {
      candidates: upsertImportCandidates([], payload.targets ?? []),
      loginUser: String(payload.loginUser ?? fieldValues.loginUser ?? "").trim(),
      skipped: Array.isArray(payload.skipped) ? payload.skipped.length : 0,
    };
  };

  const saveCurrent = useCallback(async () => {
    if (!importer) return;
    try {
      setBusy(true);
      const saved = await upsertImporterSource(pluginId, fields, {
        id: editingId ?? undefined,
        name: values.name ?? "",
        values,
        secrets: values,
        authMode,
        keyId: authMode === "key" ? keyId : "",
      });
      const list = await refreshSources();
      const next = list.find((item) => item.id === saved.id) ?? saved;
      applySource(next, "edit");
      setSelectedSourceIds((prev) => new Set(prev).add(next.id));
      setValues((prev) => {
        const cleared = { ...prev };
        for (const field of fields) {
          if (field.kind === "secret") cleared[field.key] = "";
        }
        return cleared;
      });
      setStatus({ kind: "success", message: t("plugins.importer.saved") });
    } catch (err) {
      setStatus({ kind: "error", message: formatIpcError(err) });
    } finally {
      setBusy(false);
    }
  }, [authMode, editingId, fields, importer, keyId, pluginId, refreshSources, t, values]);

  const scanDocker = useCallback(
    async (targets: DockerConnectionInfo[]) => {
      if (!importer) throw new Error(t("plugins.importer.contributionMissing"));
      let merged: ImportCandidate[] = [];
      let skipped = 0;
      for (const docker of targets) {
        const fetched = await scanDockerDatabases({
          pluginId,
          importer,
          docker,
          connections,
        });
        merged = upsertImportCandidates(merged, fetched.candidates);
        skipped += fetched.skipped;
      }
      return { merged, skipped };
    },
    [connections, importer, pluginId, t],
  );

  const loadCandidates = useCallback(async () => {
    if (!importer) return;
    setPane("resources");
    setSettingsOpen(false);
    setStatus({
      kind: "info",
      message: t(dockerMode ? "plugins.importer.scanning" : "plugins.importer.fetching"),
    });
    try {
      setBusy(true);
      if (dockerMode) {
        const docker = dockerConnections.find((item) => item.connectionId === editingId);
        if (!docker) {
          setStatus({ kind: "error", message: t("plugins.importer.selectDocker") });
          return;
        }
        const fetched = await scanDocker([docker]);
        setCandidates(fetched.merged);
        setSelectedIds(new Set(fetched.merged.map((item) => item.remoteId)));
        setStatus({
          kind: fetched.merged.length > 0 ? "success" : "info",
          message: fetchStatusMessage(t, fetched.merged.length, fetched.skipped),
        });
        return;
      }
      const source = editingId ? sources.find((item) => item.id === editingId) : undefined;
      const fetched = await fetchFrom(source, values);
      if (source && fetched.loginUser && fetched.loginUser !== source.values.loginUser) {
        await upsertImporterSource(pluginId, fields, {
          id: source.id,
          name: source.name,
          values: { ...source.values, loginUser: fetched.loginUser },
          secrets: {},
        });
        await refreshSources();
        setValues((prev) => ({ ...prev, loginUser: fetched.loginUser }));
      }
      const mapped = fetched.candidates;
      setCandidates(mapped);
      setSelectedIds(new Set(mapped.map((item) => item.remoteId)));
      setStatus({
        kind: mapped.length > 0 ? "success" : "info",
        message: fetchStatusMessage(t, mapped.length, fetched.skipped),
      });
    } catch (err) {
      setStatus({ kind: "error", message: formatIpcError(err) });
    } finally {
      setBusy(false);
    }
  }, [
    connections,
    dockerConnections,
    dockerMode,
    editingId,
    fields,
    importer,
    pluginId,
    refreshSources,
    scanDocker,
    sources,
    t,
    values,
  ]);

  const updateChecked = useCallback(async () => {
    if (!importer) return;
    if (dockerMode) {
      const chosen = dockerConnections.filter((item) => selectedSourceIds.has(item.connectionId));
      if (chosen.length === 0) {
        setStatus({ kind: "error", message: t("plugins.importer.selectDocker") });
        return;
      }
      setBusy(true);
      setPane("resources");
      setSettingsOpen(false);
      setStatus({ kind: "info", message: t("plugins.importer.scanning") });
      try {
        const fetched = await scanDocker(chosen);
        setCandidates(fetched.merged);
        setSelectedIds(new Set(fetched.merged.map((item) => item.remoteId)));
        setEditingId(chosen[0]?.connectionId ?? null);
        setStatus({
          kind: "success",
          message: t("plugins.importer.refetched", {
            count: chosen.length,
            loaded: fetched.merged.length,
            skipped: fetched.skipped,
          }),
        });
      } catch (err) {
        setStatus({ kind: "error", message: formatIpcError(err) });
      } finally {
        setBusy(false);
      }
      return;
    }
    const chosen = sources.filter((item) => selectedSourceIds.has(item.id));
    if (chosen.length === 0) {
      setStatus({ kind: "error", message: t("plugins.importer.selectSource") });
      return;
    }
    setBusy(true);
    setPane("resources");
    setSettingsOpen(false);
    setStatus({ kind: "info", message: t("plugins.importer.fetching") });
    try {
      let merged: ImportCandidate[] = [];
      let skipped = 0;
      for (const source of chosen) {
        const fetched = await fetchFrom(source, { ...source.values });
        merged = upsertImportCandidates(merged, fetched.candidates);
        skipped += fetched.skipped;
      }
      await refreshSources();
      setCandidates(merged);
      setSelectedIds(new Set(merged.map((item) => item.remoteId)));
      if (chosen[0]) applySource(chosen[0], "resources");
      setStatus({
        kind: "success",
        message: t("plugins.importer.refetched", {
          count: chosen.length,
          loaded: merged.length,
          skipped,
        }),
      });
    } catch (err) {
      setStatus({ kind: "error", message: formatIpcError(err) });
    } finally {
      setBusy(false);
    }
  }, [
    connections,
    dockerConnections,
    dockerMode,
    importer,
    pluginId,
    refreshSources,
    scanDocker,
    selectedSourceIds,
    sources,
    t,
  ]);

  const handleImport = useCallback(async () => {
    const chosen = candidates.filter((item) => selectedIds.has(item.remoteId));
    if (chosen.length === 0 || !importer) return;
    setBusy(true);
    try {
      const host = createPluginHost(pluginId);
      const source = editingId ? sources.find((item) => item.id === editingId) : undefined;
      for (const item of chosen) {
        await host.connections.upsert(applyImportMeta(item, source));
      }
      setStatus({ kind: "success", message: t("plugins.importer.imported") });
    } catch (err) {
      setStatus({ kind: "error", message: formatIpcError(err) });
    } finally {
      setBusy(false);
    }
  }, [applyImportMeta, candidates, editingId, importer, pluginId, selectedIds, sources, t]);

  const removeSource = async (id: string) => {
    setBusy(true);
    try {
      await deleteImporterSource(pluginId, id);
      const list = await refreshSources();
      setSelectedSourceIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (editingId === id) {
        if (list[0]) applySource(list[0], "resources");
        else resetEditor();
      }
      setStatus({ kind: "info", message: t("plugins.importer.deleted") });
    } catch (err) {
      setStatus({ kind: "error", message: formatIpcError(err) });
    } finally {
      setBusy(false);
    }
  };

  const setField = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const activeSource = editingId ? sources.find((item) => item.id === editingId) : undefined;
  const activeDocker = editingId
    ? dockerConnections.find((item) => item.connectionId === editingId)
    : undefined;
  const resourcesTitle = dockerMode
    ? activeDocker?.name || t("plugins.importer.resourcesTitle")
    : activeSource?.name || t("plugins.importer.resourcesTitle");
  const title = importer ? resolveImporterText(importer.title, t) : t("plugins.importer.unknown");
  const subtitle = importer ? resolveImporterText(importer.hint, t) : "";

  const renderFields = () =>
    fields.map((field) => {
      const value = values[field.key] ?? "";
      const label = resolveImporterText(field.label, t);
      const placeholder = resolveImporterText(
        editingId && field.kind === "secret" ? field.savedHint || field.placeholder : field.placeholder || field.label,
        t,
      );
      if (field.kind === "checkbox") {
        return (
          <label key={field.key} className="form-field importer-wizard__check">
            <input
              type="checkbox"
              checked={isChecked(value)}
              onChange={(event) => setField(field.key, event.target.checked ? "true" : "false")}
            />
            <span>{label}</span>
          </label>
        );
      }
      return (
        <div key={field.key} className="form-field">
          <label className="form-label">{label}</label>
          {field.kind === "secret" ? (
            <PasswordInput
              value={value}
              onChange={(next) => setField(field.key, next)}
              placeholder={placeholder}
            />
          ) : (
            <TextInput
              value={value}
              onChange={(next) => setField(field.key, next)}
              placeholder={placeholder}
            />
          )}
        </div>
      );
    });

  return (
    <FormDialog
      open={open}
      onClose={() => setOpen(false)}
      title={title}
      subtitle={subtitle}
      size="xl"
      className="importer-wizard-dialog"
      bodyClassName="importer-wizard-body"
      headerExtra={
        <button
          type="button"
          className={`btn btn-ghost btn-icon importer-wizard__gear${settingsOpen ? " is-active" : ""}`}
          title={t("plugins.importer.importMeta")}
          aria-label={t("plugins.importer.importMeta")}
          aria-pressed={settingsOpen}
          onClick={() => setSettingsOpen((current) => !current)}
        >
          <IconSettings size={16} />
        </button>
      }
      status={status}
      primaryAction={{
        label: t("plugins.importer.import"),
        disabled: busy || pane !== "resources" || selectedIds.size === 0,
        onClick: () => void handleImport(),
      }}
    >
      <div className="importer-wizard">
        <aside className="importer-wizard__rail">
          <div className="importer-wizard__rail-head">
            <span>{t(dockerMode ? "plugins.importer.dockerSources" : "plugins.importer.sources")}</span>
            {dockerMode ? null : (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={resetEditor}>
                {t("plugins.importer.newSource")}
              </button>
            )}
          </div>
          {dockerMode ? (
            dockerConnections.length === 0 ? (
              <p className="setting-hint importer-wizard__empty">{t("plugins.importer.emptyDocker")}</p>
            ) : (
              <div className="importer-wizard-source-list" role="list" aria-label={t("plugins.importer.dockerSources")}>
                {dockerConnections.map((docker) => (
                  <div key={docker.connectionId} className="importer-wizard-source-row" role="listitem">
                    <input
                      type="checkbox"
                      checked={selectedSourceIds.has(docker.connectionId)}
                      onChange={(event) => {
                        setSelectedSourceIds((prev) => {
                          const next = new Set(prev);
                          if (event.target.checked) next.add(docker.connectionId);
                          else next.delete(docker.connectionId);
                          return next;
                        });
                      }}
                    />
                    <button
                      type="button"
                      className={
                        editingId === docker.connectionId && pane === "resources"
                          ? "btn btn-ghost is-active"
                          : "btn btn-ghost"
                      }
                      onClick={() => {
                        setEditingId(docker.connectionId);
                        setPane("resources");
                        setSettingsOpen(false);
                      }}
                    >
                      {docker.name}
                    </button>
                  </div>
                ))}
              </div>
            )
          ) : sources.length === 0 ? (
            <p className="setting-hint importer-wizard__empty">{t("plugins.importer.emptySources")}</p>
          ) : (
            <div className="importer-wizard-source-list" role="list" aria-label={t("plugins.importer.sources")}>
              {sources.map((source) => (
                <div key={source.id} className="importer-wizard-source-row" role="listitem">
                  <input
                    type="checkbox"
                    checked={selectedSourceIds.has(source.id)}
                    onChange={(event) => {
                      setSelectedSourceIds((prev) => {
                        const next = new Set(prev);
                        if (event.target.checked) next.add(source.id);
                        else next.delete(source.id);
                        return next;
                      });
                    }}
                  />
                  <button
                    type="button"
                    className={
                      editingId === source.id && pane === "resources"
                        ? "btn btn-ghost is-active"
                        : "btn btn-ghost"
                    }
                    onClick={() => applySource(source, "resources")}
                  >
                    {source.name}
                  </button>
                  <button
                    type="button"
                    className={
                      editingId === source.id && pane === "edit"
                        ? "btn btn-ghost is-active"
                        : "btn btn-ghost"
                    }
                    disabled={busy}
                    onClick={() => applySource(source, "edit")}
                  >
                    {t("plugins.importer.editSource")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => void removeSource(source.id)}
                  >
                    {t("plugins.importer.deleteSource")}
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            className="btn btn-secondary importer-wizard__update"
            disabled={busy || selectedSourceIds.size === 0}
            onClick={() => void updateChecked()}
          >
            {t(dockerMode ? "plugins.importer.scanSelected" : "plugins.importer.updateSelected")}
          </button>
        </aside>

        <section className="importer-wizard__main" aria-live="polite">
          {settingsOpen ? (
            <div className="importer-wizard__editor">
              <h4 className="importer-wizard__pane-title">{t("plugins.importer.importMeta")}</h4>
              {groupFields.map((field) => {
                const value = importGroups[field.kind] ?? "";
                const label =
                  groupFields.length === 1
                    ? t("plugins.importer.importGroup")
                    : t("plugins.importer.groupKind", { kind: groupKindLabel(field.kind) });
                const folderOptions = collectImportGroupSuggestions(
                  groupOptionsByDest[field.dest],
                  value,
                );
                return (
                  <div className="form-field" key={field.kind}>
                    <label className="form-label">{label}</label>
                    <Select
                      value={value}
                      onChange={(next) =>
                        setImportGroups((prev) => ({
                          ...prev,
                          [field.kind]: sanitizeImportGroupInput(next),
                        }))
                      }
                      options={[
                        { value: "", label: t("plugins.importer.importGroupRoot") },
                        ...folderOptions.map((name) => ({ value: name, label: name })),
                      ]}
                      searchable
                      allowCustom
                      formatCustomOption={(name) => name}
                      placeholder={t("plugins.importer.importGroupPlaceholder")}
                      style={{ width: "100%" }}
                    />
                  </div>
                );
              })}
              <p className="form-hint">{t("plugins.importer.importGroupHint")}</p>
              <div className="form-field">
                <label className="form-label">{t("plugins.importer.importTags")}</label>
                <ResourceTagEditor
                  tags={importTags}
                  lockedTags={lockedTag ? [lockedTag] : []}
                  onChange={(next) => setImportTags(importer ? withDefaultTags(importer, next) : next)}
                />
              </div>
            </div>
          ) : !dockerMode && pane === "edit" ? (
            <div className="importer-wizard__editor">
              <h4 className="importer-wizard__pane-title">
                {editingId ? t("plugins.importer.editSource") : t("plugins.importer.newSource")}
              </h4>
              {renderFields()}
              {importer?.sshAuth ? (
                <>
                  <div className="form-field">
                    <label className="form-label">{t("plugins.importer.authMode")}</label>
                    <div className="importer-wizard__auth">
                      <button
                        type="button"
                        className={`engine-chip${authMode === "password" ? " engine-chip--active" : ""}`}
                        onClick={() => setAuthMode("password")}
                      >
                        <span>{t("plugins.importer.authPassword")}</span>
                      </button>
                      <button
                        type="button"
                        className={`engine-chip${authMode === "key" ? " engine-chip--active" : ""}`}
                        onClick={() => setAuthMode("key")}
                      >
                        <span>{t("plugins.importer.authKey")}</span>
                      </button>
                    </div>
                  </div>
                  {authMode === "key" ? (
                    <div className="form-field">
                      <label className="form-label">{t("plugins.importer.keySelect")}</label>
                      <Select
                        value={keyId}
                        onChange={setKeyId}
                        options={keyOptions}
                        searchable
                        placeholder={t("plugins.importer.keySelect")}
                        style={{ width: "100%" }}
                        emptyText={t("plugins.importer.keyEmpty")}
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
              {importer?.note ? <p className="setting-hint">{resolveImporterText(importer.note, t)}</p> : null}
              <div className="importer-wizard__actions">
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void saveCurrent()}>
                  {t("plugins.importer.saveSource")}
                </button>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void loadCandidates()}>
                  {t("plugins.importer.load")}
                </button>
              </div>
            </div>
          ) : (
            <div className="importer-wizard__resources">
              <div className="importer-wizard__resources-head">
                <h4 className="importer-wizard__pane-title">{resourcesTitle}</h4>
                <div className="importer-wizard__actions">
                  {dockerMode ? null : (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy || !editingId}
                      onClick={() => {
                        if (activeSource) applySource(activeSource, "edit");
                      }}
                    >
                      {t("plugins.importer.editSource")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || (dockerMode && !editingId)}
                    onClick={() => void loadCandidates()}
                  >
                    {t(dockerMode ? "plugins.importer.scan" : "plugins.importer.load")}
                  </button>
                </div>
              </div>
              {candidates.length === 0 ? (
                <p className="setting-hint importer-wizard__empty">
                  {busy
                    ? t(dockerMode ? "plugins.importer.scanning" : "plugins.importer.fetching")
                    : t(dockerMode ? "plugins.importer.paneScanEmpty" : "plugins.importer.paneResourcesEmpty")}
                </p>
              ) : (
                <ImportPreview
                  items={candidates.map((item) => ({
                    id: item.remoteId,
                    name: item.name,
                    host: String((item.config as { host?: string } | undefined)?.host ?? ""),
                    kind: item.remoteKind,
                  }))}
                  selectedIds={selectedIds}
                  selectAllLabel={t("plugins.importer.selectAll")}
                  onToggle={(id, next) => {
                    setSelectedIds((prev) => {
                      const copy = new Set(prev);
                      if (next) copy.add(id);
                      else copy.delete(id);
                      return copy;
                    });
                  }}
                  columns={[
                    { id: "name", header: t("plugins.importer.colName"), render: (row) => row.name },
                    { id: "kind", header: t("plugins.importer.colKind"), render: (row) => row.kind },
                    { id: "host", header: t("plugins.importer.colHost"), render: (row) => row.host },
                  ]}
                />
              )}
            </div>
          )}
        </section>
      </div>
    </FormDialog>
  );
}
