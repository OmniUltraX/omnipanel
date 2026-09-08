import type { SubmitPreview } from "../../ipc/bindings";
import { FormDialog } from "../../components/ui/form/FormDialog";
import { PasswordInput } from "../../components/ui/form/PasswordInput";
import { TextInput } from "../../components/ui/form/TextInput";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { useI18n } from "../../i18n";
import { canConfirmSubmit } from "./submitFormat";

type Props = {
  open: boolean;
  project: string;
  preview: SubmitPreview | null;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  tokenDraft: string;
  artifactUrl: string;
  changelog: string;
  repo: string;
  onArtifactUrl: (value: string) => void;
  onChangelog: (value: string) => void;
  onRepo: (value: string) => void;
  onTokenDraft: (value: string) => void;
  onPreview: () => void;
  onSaveToken: () => void;
  onSubmit: () => void;
  onClose: () => void;
};

export function StudioSubmitDialog({
  open,
  project,
  preview,
  loading,
  submitting,
  error,
  tokenDraft,
  artifactUrl,
  changelog,
  repo,
  onArtifactUrl,
  onChangelog,
  onRepo,
  onTokenDraft,
  onPreview,
  onSaveToken,
  onSubmit,
  onClose,
}: Props) {
  const { t } = useI18n();
  const overLimit = Boolean(preview?.waitMs);
  const canSubmit = canConfirmSubmit(preview) && !submitting && !loading;

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("plugins.studio.submit.title")}
      subtitle={project}
      size="lg"
      cancelLabel={t("common.cancel")}
      primaryAction={{
        label: submitting ? t("plugins.studio.submit.sending") : t("plugins.studio.submit.confirm"),
        disabled: !canSubmit,
        onClick: onSubmit,
      }}
    >
      <p className="text-xs text-muted mb-3">{t("plugins.studio.submit.rateHint")}</p>
      <div className="space-y-2 mb-3">
        <TextInput
          value={artifactUrl}
          onChange={onArtifactUrl}
          placeholder={t("plugins.studio.submit.artifactUrl")}
          size="sm"
          clearable
          copyable={false}
        />
        <TextInput
          value={changelog}
          onChange={onChangelog}
          placeholder={t("plugins.studio.submit.changelog")}
          size="sm"
          clearable
          copyable={false}
        />
        <TextInput
          value={repo}
          onChange={onRepo}
          placeholder={t("plugins.studio.submit.repo")}
          size="sm"
          clearable
          copyable={false}
        />
        <WorkbenchActionButton disabled={loading || !artifactUrl.trim()} onClick={onPreview}>
          {loading ? t("plugins.studio.submit.loading") : t("plugins.studio.submit.preview")}
        </WorkbenchActionButton>
      </div>
      {preview && !preview.hasToken ? (
        <div className="space-y-2 mb-3">
          <p className="text-xs text-muted">{t("plugins.studio.submit.tokenHint")}</p>
          <div className="flex gap-2">
            <PasswordInput
              value={tokenDraft}
              onChange={onTokenDraft}
              placeholder={t("plugins.studio.submit.token")}
              size="sm"
              copyable={false}
            />
            <WorkbenchActionButton disabled={!tokenDraft.trim() || submitting} onClick={onSaveToken}>
              {t("plugins.studio.submit.saveToken")}
            </WorkbenchActionButton>
          </div>
        </div>
      ) : null}
      {preview?.hasToken ? (
        <p className="text-xs text-muted mb-2">{t("plugins.studio.submit.tokenReady")}</p>
      ) : null}
      {overLimit ? (
        <p className="text-xs text-danger mb-2">{t("plugins.studio.submit.overLimit")}</p>
      ) : null}
      {preview?.needsManualReview ? (
        <p className="text-xs text-danger mb-2">{t("plugins.studio.submit.dangerPerms")}</p>
      ) : null}
      {preview ? (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            {t("plugins.studio.submit.target")}: <span className="font-mono">{preview.repo}</span>
            {" · "}
            {t("plugins.studio.submit.remaining", { count: preview.remaining })}
          </p>
          <p className="text-xs font-mono">{preview.title}</p>
          <pre className="text-xs text-fg-2 whitespace-pre-wrap max-h-56 overflow-auto border border-border rounded p-2">
            {preview.body}
          </pre>
        </div>
      ) : null}
      {error ? <p className="text-xs text-danger mt-2">{error}</p> : null}
    </FormDialog>
  );
}
