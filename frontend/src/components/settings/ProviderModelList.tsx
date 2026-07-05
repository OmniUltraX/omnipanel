import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/primitives/Button";
import { TextInput } from "../ui/form/TextInput";
import { useI18n } from "../../i18n";
import {
  countEnabledModels,
  getApiModelMeta,
  isManualModel,
  isModelEnabled,
  useAiModelsStore,
  type AiModelProvider,
} from "../../stores/aiModelsStore";
import { formatApiModelCreated, fuzzyMatchModelName } from "../../lib/fetchProviderModels";

const PAGE_SIZE = 21;

function ModelToggle({
  enabled,
  onChange,
  label,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`toggle${enabled ? " on" : ""}`}
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={() => onChange(!enabled)}
    />
  );
}

function ModelListItem({
  provider,
  modelName,
  onEditStart,
  isEditing,
  editDraft,
  editError,
  onEditDraftChange,
  onEditSave,
  onEditCancel,
  confirmDelete,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}: {
  provider: AiModelProvider;
  modelName: string;
  onEditStart: () => void;
  isEditing: boolean;
  editDraft: string;
  editError: string | null;
  onEditDraftChange: (value: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  confirmDelete: boolean;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}) {
  const { t, locale } = useI18n();
  const setModelEnabled = useAiModelsStore((s) => s.setModelEnabled);
  const editInputRef = useRef<HTMLInputElement>(null);

  const enabled = isModelEnabled(provider, modelName);
  const manual = isManualModel(provider, modelName);
  const apiMeta = getApiModelMeta(provider, modelName);
  const metaParts: string[] = [];
  if (apiMeta?.ownedBy) {
    metaParts.push(t("settings.aiModels.modelList.metaOwnedBy", { owner: apiMeta.ownedBy }));
  }
  if (apiMeta?.created != null) {
    metaParts.push(
      t("settings.aiModels.modelList.metaCreated", {
        date: formatApiModelCreated(apiMeta.created, locale),
      }),
    );
  }

  useEffect(() => {
    if (isEditing) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [isEditing]);

  if (isEditing) {
    return (
      <li className="ai-provider-model-item ai-provider-model-item--editing">
        <TextInput
          ref={editInputRef}
          clearable={false}
          copyable={false}
          className="input ai-provider-model-edit-input"
          value={editDraft}
          onChange={onEditDraftChange}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onEditSave();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onEditCancel();
            }
          }}
        />
        {editError ? <div className="form-error ai-provider-model-edit-error">{editError}</div> : null}
        <div className="ai-provider-model-edit-actions">
          <Button variant="primary" size="sm" onClick={onEditSave}>
            {t("settings.aiModels.modelList.editSave")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onEditCancel}>
            {t("settings.aiModels.modelList.editCancel")}
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="ai-provider-model-item">
      <div className="ai-provider-model-item-main">
        <div className="ai-provider-model-name-row">
          <span className="ai-provider-model-name" title={modelName}>
            {modelName}
          </span>
          <span
            className={`ai-provider-model-source-tag ai-provider-model-source-tag--${manual ? "manual" : "api"}`}
          >
            {manual
              ? t("settings.aiModels.modelList.tagManual")
              : t("settings.aiModels.modelList.tagApi")}
          </span>
        </div>
        {metaParts.length > 0 ? (
          <div className="ai-provider-model-meta">{metaParts.join(" · ")}</div>
        ) : null}
      </div>

      {confirmDelete ? (
        <div className="ai-provider-model-delete-confirm">
          <Button variant="danger" size="sm" onClick={onDeleteConfirm}>
            {t("settings.aiModels.confirmDelete")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDeleteCancel}>
            {t("settings.aiModels.cancelDelete")}
          </Button>
        </div>
      ) : (
        <div className="ai-provider-model-item-actions">
          <ModelToggle
            enabled={enabled}
            label={t("settings.aiModels.modelList.toggleModel", { name: modelName })}
            onChange={(next) => setModelEnabled(provider.id, modelName, next)}
          />
          <div className="ai-provider-model-item-btns">
            {manual ? (
              <Button
                variant="ghost"
                size="sm"
                className="ai-provider-model-item-btn ai-model-row-edit"
                title={t("settings.aiModels.editBtn")}
                aria-label={t("settings.aiModels.modelList.editModel", { name: modelName })}
                onClick={onEditStart}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  width="14"
                  height="14"
                  aria-hidden
                >
                  <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="ai-provider-model-item-btn ai-model-row-delete"
              title={t("settings.aiModels.deleteBtn")}
              aria-label={t("settings.aiModels.modelList.deleteModel", { name: modelName })}
              onClick={onDeleteRequest}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                width="14"
                height="14"
                aria-hidden
              >
                <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
              </svg>
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

interface ProviderModelListProps {
  provider: AiModelProvider;
}

export function ProviderModelList({ provider }: ProviderModelListProps) {
  const { t } = useI18n();
  const setAllModelsEnabled = useAiModelsStore((s) => s.setAllModelsEnabled);
  const addManualModel = useAiModelsStore((s) => s.addManualModel);
  const removeModel = useAiModelsStore((s) => s.removeModel);
  const renameManualModel = useAiModelsStore((s) => s.renameManualModel);

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [manualInput, setManualInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmDeleteModel, setConfirmDeleteModel] = useState<string | null>(null);
  const toggleAllRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => provider.modelNames.filter((name) => fuzzyMatchModelName(name, search)),
    [provider.modelNames, search],
  );

  useEffect(() => {
    setPage(0);
  }, [search, provider.id, provider.modelNames.length]);

  useEffect(() => {
    setEditingModel(null);
    setEditDraft("");
    setEditError(null);
    setConfirmDeleteModel(null);
  }, [provider.id]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const enabledCount = countEnabledModels(provider);
  const totalCount = provider.modelNames.length;
  const allEnabled = totalCount > 0 && enabledCount === totalCount;
  const someEnabled = enabledCount > 0 && !allEnabled;

  useEffect(() => {
    const el = toggleAllRef.current;
    if (!el) return;
    el.indeterminate = someEnabled;
  }, [someEnabled]);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const handleAddManual = () => {
    const result = addManualModel(provider.id, manualInput);
    if (!result.ok) {
      if (result.error === "empty") {
        setAddError(t("settings.aiModels.modelList.addEmpty"));
      } else if (result.error === "duplicate") {
        setAddError(t("settings.aiModels.modelList.addDuplicate", { name: manualInput.trim() }));
      }
      return;
    }
    setManualInput("");
    setAddError(null);
  };

  const startEdit = (modelName: string) => {
    setConfirmDeleteModel(null);
    setEditingModel(modelName);
    setEditDraft(modelName);
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingModel(null);
    setEditDraft("");
    setEditError(null);
  };

  const saveEdit = () => {
    if (!editingModel) return;
    const result = renameManualModel(provider.id, editingModel, editDraft);
    if (!result.ok) {
      if (result.error === "empty") {
        setEditError(t("settings.aiModels.modelList.addEmpty"));
      } else if (result.error === "duplicate") {
        setEditError(t("settings.aiModels.modelList.addDuplicate", { name: editDraft.trim() }));
      } else if (result.error === "not_manual") {
        setEditError(t("settings.aiModels.modelList.renameNotManual"));
      }
      return;
    }
    cancelEdit();
  };

  const handleDeleteConfirm = (modelName: string) => {
    removeModel(provider.id, modelName);
    setConfirmDeleteModel(null);
    if (editingModel === modelName) cancelEdit();
  };

  return (
    <div className="ai-provider-models-panel">
      <div className="ai-provider-models-toolbar">
        <TextInput
          className="input input-search ai-provider-models-search"
          value={search}
          onChange={setSearch}
          copyable={false}
          placeholder={t("settings.aiModels.modelList.searchPlaceholder")}
        />
        <TextInput
          className="input ai-provider-models-add-input"
          value={manualInput}
          onChange={(value) => {
            setManualInput(value);
            setAddError(null);
          }}
          placeholder={t("settings.aiModels.modelList.addPlaceholder")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAddManual();
            }
          }}
        />
        <Button variant="secondary" size="sm" onClick={handleAddManual}>
          {t("settings.aiModels.modelList.addBtn")}
        </Button>
        <label className="ai-provider-models-bulk">
          <input
            ref={toggleAllRef}
            type="checkbox"
            checked={allEnabled}
            disabled={totalCount === 0}
            onChange={(e) => setAllModelsEnabled(provider.id, e.target.checked)}
            aria-label={t("settings.aiModels.modelList.toggleAll")}
          />
          <span>{t("settings.aiModels.modelList.toggleAll")}</span>
        </label>
      </div>
      {addError ? <div className="form-error ai-provider-models-add-error">{addError}</div> : null}

      <div className="ai-provider-models-summary">
        {t("settings.aiModels.modelList.enabledSummary", {
          enabled: enabledCount,
          total: provider.modelNames.length,
          filtered: search.trim() ? filtered.length : provider.modelNames.length,
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="ai-provider-models-empty">{t("settings.aiModels.modelList.noMatch")}</div>
      ) : (
        <>
          <ul className="ai-provider-models">
            {pageItems.map((modelName) => (
              <ModelListItem
                key={modelName}
                provider={provider}
                modelName={modelName}
                isEditing={editingModel === modelName}
                editDraft={editDraft}
                editError={editError}
                onEditStart={() => startEdit(modelName)}
                onEditDraftChange={(value) => {
                  setEditDraft(value);
                  setEditError(null);
                }}
                onEditSave={saveEdit}
                onEditCancel={cancelEdit}
                confirmDelete={confirmDeleteModel === modelName}
                onDeleteRequest={() => {
                  cancelEdit();
                  setConfirmDeleteModel(modelName);
                }}
                onDeleteConfirm={() => handleDeleteConfirm(modelName)}
                onDeleteCancel={() => setConfirmDeleteModel(null)}
              />
            ))}
          </ul>

          {totalPages > 1 && (
            <div className="ai-provider-models-pagination">
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage <= 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                {t("settings.aiModels.modelList.prevPage")}
              </Button>
              <span className="ai-provider-models-page-info">
                {t("settings.aiModels.modelList.pageInfo", {
                  page: safePage + 1,
                  total: totalPages,
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                {t("settings.aiModels.modelList.nextPage")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
