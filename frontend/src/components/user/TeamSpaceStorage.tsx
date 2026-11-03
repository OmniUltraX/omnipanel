import { useCallback, useEffect, useState } from "react";
import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useI18n } from "../../i18n";
import { useAuthStore } from "../../stores/authStore";
import { showToast } from "../../stores/toastStore";
import { FormDialog, FormField } from "../ui/form/FormDialog";
import { PasswordInput } from "../ui/form/PasswordInput";
import { TextInput } from "../ui/form/TextInput";
import { WorkbenchActionButton } from "../ui/primitives";

type StorageKind = "hosted" | "s3";

/** 团队仓库放哪。访问密钥进本机钥匙串，不进同步仓库。 */
export function TeamSpaceStorage({ teamId }: { teamId: number }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<StorageKind>("hosted");
  const [savedKind, setSavedKind] = useState<StorageKind>("hosted");
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useAuthStore((s) => s.token) ?? "";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await unwrapCommand(commands.localSpaceStorageGet(teamId));
      const nextKind = settings.kind === "s3" ? "s3" : "hosted";
      setKind(nextKind);
      setSavedKind(nextKind);
      setEndpoint(settings.endpoint);
      setBucket(settings.bucket);
      setRegion(settings.region);
      setAccessKeyId(settings.accessKeyId);
      setHasSecret(settings.hasSecret);
      setReady(settings.ready);
      setSecret("");
    } catch (err) {
      setError(formatIpcError(err));
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await unwrapCommand(
        commands.localSpaceStoragePut({
          teamId,
          kind,
          endpoint,
          bucket,
          region,
          accessKeyId,
          secretAccessKey: secret,
        }),
      );
      setHasSecret(saved.hasSecret);
      setAccessKeyId(saved.accessKeyId);
      setReady(saved.ready);
      setSavedKind(saved.kind === "s3" ? "s3" : "hosted");
      setSecret("");
      showToast(t("userCenter.teams.storageSaved"));
    } catch (err) {
      setError(formatIpcError(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="user-center-devices__hint">{t("userCenter.teams.storageLoading")}</p>;
  }

  const inUse: StorageKind = savedKind === "s3" && ready ? "s3" : "hosted";
  const note = kind === "s3" && ready ? t("userCenter.teams.storageReady") : "";

  return (
    <div className="space-storage">
      <div>
        <h4 className="user-center-teams-detail__subtitle">{t("userCenter.teams.storageTitle")}</h4>
        <p className="space-storage__note">{t("userCenter.teams.storageDesc")}</p>
      </div>
      <div className="space-storage__choices" role="radiogroup" aria-label={t("userCenter.teams.storageTitle")}>
        <button
          type="button"
          role="radio"
          aria-checked={kind === "hosted"}
          className={`space-storage__choice${kind === "hosted" ? " is-selected" : ""}`}
          onClick={() => setKind("hosted")}
        >
          <span className="space-storage__choice-title">
            {t("userCenter.teams.storageHosted")}
            {inUse === "hosted" ? (
              <span className="space-storage__badge">{t("userCenter.teams.storageInUse")}</span>
            ) : null}
          </span>
          <span className="space-storage__choice-body">{t("userCenter.teams.storageHostedHint")}</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={kind === "s3"}
          className={`space-storage__choice${kind === "s3" ? " is-selected" : ""}`}
          onClick={() => setKind("s3")}
        >
          <span className="space-storage__choice-title">
            {t("userCenter.teams.storageOwn")}
            {inUse === "s3" ? (
              <span className="space-storage__badge">{t("userCenter.teams.storageInUse")}</span>
            ) : null}
          </span>
          <span className="space-storage__choice-body">{t("userCenter.teams.storageOwnHint")}</span>
        </button>
      </div>
      {kind === "s3" ? (
        <div className="space-storage__form">
          <FormField label={t("userCenter.teams.storageEndpoint")} className="space-storage__span">
            <TextInput className="input" value={endpoint} onChange={setEndpoint} disabled={saving} />
          </FormField>
          <FormField label={t("userCenter.teams.storageBucket")}>
            <TextInput className="input" value={bucket} onChange={setBucket} disabled={saving} />
          </FormField>
          <FormField label={t("userCenter.teams.storageRegion")}>
            <TextInput className="input" value={region} onChange={setRegion} disabled={saving} />
          </FormField>
          <FormField label={t("userCenter.teams.storageAccessKey")}>
            <TextInput className="input" value={accessKeyId} onChange={setAccessKeyId} disabled={saving} />
          </FormField>
          <FormField label={t("userCenter.teams.storageSecret")}>
            <PasswordInput
              className="input"
              value={secret}
              onChange={setSecret}
              disabled={saving}
              placeholder={hasSecret ? t("userCenter.teams.storageSecretKept") : ""}
            />
          </FormField>
        </div>
      ) : null}
      {error ? <p className="user-center-devices__error">{error}</p> : null}
      {kind === "hosted" && inUse === "hosted" ? null : (
        <div className="space-storage__actions">
          {note ? <p className="space-storage__note">{note}</p> : null}
          <div className="space-storage__actions-buttons">
            <WorkbenchActionButton onClick={() => void save()} disabled={saving || copying}>
              {saving ? t("userCenter.teams.storageSaving") : t("userCenter.teams.storageSave")}
            </WorkbenchActionButton>
            {kind === "s3" ? (
              <WorkbenchActionButton onClick={() => void copyIntoBucket()} disabled={saving || copying || !token.trim()}>
                {copying ? t("userCenter.teams.storageCopying") : t("userCenter.teams.storageCopy")}
              </WorkbenchActionButton>
            ) : null}
            {kind === "s3" ? (
              <WorkbenchActionButton danger onClick={() => setPurgeOpen(true)} disabled={saving || copying}>
                {t("userCenter.teams.storagePurge")}
              </WorkbenchActionButton>
            ) : null}
          </div>
        </div>
      )}
      <FormDialog
        open={purgeOpen}
        onClose={() => setPurgeOpen(false)}
        title={t("userCenter.teams.storagePurge")}
        subtitle={t("userCenter.teams.storagePurgeBody")}
        cancelLabel={t("app.claim.exportLater")}
        primaryAction={{
          label: t("userCenter.teams.storagePurge"),
          onClick: () => void purgeBucket(),
        }}
      >
        {null}
      </FormDialog>
    </div>
  );

  async function copyIntoBucket() {
    setCopying(true);
    setError(null);
    try {
      const saved = await unwrapCommand(commands.localSpaceStorageCopy(token, teamId));
      setReady(saved.ready);
      showToast(t("userCenter.teams.storageCopied"));
    } catch (err) {
      setError(formatIpcError(err));
    } finally {
      setCopying(false);
    }
  }

  async function purgeBucket() {
    setPurgeOpen(false);
    setError(null);
    try {
      const count = await unwrapCommand(commands.localSpaceStoragePurge(teamId));
      showToast(t("userCenter.teams.storagePurged", { count }));
    } catch (err) {
      setError(formatIpcError(err));
    }
  }
}
