import { useCallback, useEffect, useState } from "react";
import { FormField } from "../../components/ui/form/FormDialog";
import { Button } from "../../components/ui/primitives/Button";
import { TextInput } from "../../components/ui/form/TextInput";
import { SubWindow } from "../../components/ui/window";
import { appConfirm } from "../../lib/appConfirm";
import { useI18n } from "../../i18n";
import type { HttpEnvironment } from "../../ipc/bindings";
import { normalizeBaseUrl } from "./httpEnvironment";
import {
  AUTH_TYPE_I18N_KEYS,
  AUTH_TYPES,
  type AuthType,
} from "./ProtocolHttpContext";

interface Props {
  open: boolean;
  onClose: () => void;
  environments: HttpEnvironment[];
  onSave: (env: HttpEnvironment) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

type EnvAuthType = AuthType | "none";

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function parseEnvAuthType(value: string | null | undefined): EnvAuthType {
  if (!value) return "none";
  return (AUTH_TYPES as readonly string[]).includes(value) ? (value as AuthType) : "none";
}

export function HttpEnvironmentManageDialog({
  open,
  onClose,
  environments,
  onSave,
  onDelete,
}: Props) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authType, setAuthType] = useState<EnvAuthType>("none");
  const [authValue, setAuthValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setIsCreating(false);
    setName("");
    setBaseUrl("");
    setAuthType("none");
    setAuthValue("");
    setError(null);
  }, []);

  const loadEnv = useCallback((env: HttpEnvironment) => {
    setEditingId(env.id);
    setIsCreating(false);
    setName(env.name);
    setBaseUrl(env.baseUrl);
    setAuthType(parseEnvAuthType(env.authType));
    setAuthValue(env.authValue ?? "");
    setError(null);
  }, []);

  const startCreate = useCallback(() => {
    setIsCreating(true);
    setEditingId(null);
    setName("");
    setBaseUrl("");
    setAuthType("none");
    setAuthValue("");
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) {
      resetForm();
      return;
    }
    if (environments[0]) {
      loadEnv(environments[0]);
    } else {
      startCreate();
    }
    // 仅在打开时初始化选中项
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open 驱动初始化
  }, [open]);

  useEffect(() => {
    if (!open || editingId || !isCreating) return;
    // 打开瞬间列表尚未加载：空白新建态下列表到齐后切到第一项
    if (environments[0] && !name.trim() && !baseUrl.trim()) {
      loadEnv(environments[0]);
    }
  }, [open, environments, editingId, isCreating, name, baseUrl, loadEnv]);

  const validate = (): string | null => {
    if (!name.trim()) {
      return t("protocol.environment.nameRequired");
    }
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) {
      return t("protocol.environment.baseUrlRequired");
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
      return t("protocol.environment.baseUrlInvalid");
    }
    if (authType !== "none" && !authValue.trim()) {
      return t("protocol.environment.authValueRequired");
    }
    return null;
  };

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const now = Date.now();
      const existing = editingId ? environments.find((item) => item.id === editingId) : null;
      const nextId = existing?.id ?? generateId();
      const trimmedAuth = authValue.trim();
      await onSave({
        id: nextId,
        name: name.trim(),
        baseUrl: normalizeBaseUrl(baseUrl),
        authType: authType === "none" ? null : authType,
        authValue: authType === "none" ? null : trimmedAuth || null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      setEditingId(nextId);
      setIsCreating(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (env: HttpEnvironment) => {
    const ok = await appConfirm(
      t("protocol.environment.deleteConfirm", { name: env.name }),
      t("protocol.environment.deleteTitle"),
    );
    if (!ok) return;
    await onDelete(env.id);
    if (editingId === env.id) {
      const remaining = environments.filter((item) => item.id !== env.id);
      if (remaining[0]) {
        loadEnv(remaining[0]);
      } else {
        startCreate();
      }
    }
  };

  const showForm = isCreating || editingId != null;

  return (
    <SubWindow
      open={open}
      title={t("protocol.environment.manageTitle")}
      onClose={onClose}
      widthRatio={0.72}
      heightRatio={0.72}
      className="http-env-manage-subwindow-shell"
    >
      <div className="http-env-manage">
        <aside className="http-env-manage__list">
          <div className="http-env-manage__list-header">
            <span className="http-env-manage__list-title">
              {t("protocol.environment.listTitle")}
            </span>
            <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={startCreate}>
              {t("protocol.environment.new")}
            </Button>
          </div>
          <div className="http-env-manage__list-body">
            {environments.length === 0 ? (
              <div className="http-env-manage__empty">{t("protocol.environment.empty")}</div>
            ) : (
              environments.map((env) => (
                <div
                  key={env.id}
                  className={`http-env-manage__row${
                    !isCreating && editingId === env.id ? " http-env-manage__row--active" : ""
                  }`}
                  onClick={() => loadEnv(env)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      loadEnv(env);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="http-env-manage__row-main">
                    <div className="http-env-manage__name">{env.name}</div>
                    <div className="http-env-manage__base">{env.baseUrl}</div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleDelete(env);
                    }}
                  >
                    {t("common.delete")}
                  </Button>
                </div>
              ))
            )}
          </div>
        </aside>

        <section className="http-env-manage__form">
          {!showForm ? (
            <div className="http-env-manage__empty">{t("protocol.environment.selectOrCreate")}</div>
          ) : (
            <>
              <div className="http-env-manage__form-fields">
                <FormField label={t("protocol.environment.name")}>
                  <TextInput
                    value={name}
                    onChange={setName}
                    placeholder={t("protocol.environment.namePlaceholder")}
                  />
                </FormField>
                <FormField label={t("protocol.environment.baseUrl")}>
                  <TextInput
                    value={baseUrl}
                    onChange={setBaseUrl}
                    placeholder={t("protocol.environment.baseUrlPlaceholder")}
                  />
                </FormField>
                <FormField label={t("protocol.environment.auth")}>
                  <div className="http-env-manage__auth-types">
                    <span
                      className="tag"
                      style={{
                        cursor: "pointer",
                        borderColor: authType === "none" ? "var(--accent)" : undefined,
                        color: authType === "none" ? "var(--accent)" : undefined,
                      }}
                      onClick={() => {
                        setAuthType("none");
                        setAuthValue("");
                      }}
                    >
                      {t("protocol.environment.authNone")}
                    </span>
                    {AUTH_TYPES.map((auth) => (
                      <span
                        key={auth}
                        className="tag"
                        style={{
                          cursor: "pointer",
                          borderColor: authType === auth ? "var(--accent)" : undefined,
                          color: authType === auth ? "var(--accent)" : undefined,
                        }}
                        onClick={() => setAuthType(auth)}
                      >
                        {t(`protocol.http.authTypes.${AUTH_TYPE_I18N_KEYS[auth]}`)}
                      </span>
                    ))}
                  </div>
                </FormField>
                {authType !== "none" ? (
                  <FormField label={t("protocol.environment.authValue")}>
                    <TextInput
                      value={authValue}
                      onChange={setAuthValue}
                      placeholder={
                        authType === "Authorization"
                          ? t("protocol.http.authAuthorizationPlaceholder")
                          : t("protocol.http.token")
                      }
                    />
                  </FormField>
                ) : null}
              </div>

              {error ? <div className="http-env-manage__error">{error}</div> : null}

              <div className="http-env-manage__form-actions">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={saving}
                  onClick={() => void handleSubmit()}
                >
                  {isCreating ? t("protocol.environment.add") : t("common.save")}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </SubWindow>
  );
}
