import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { TextInput } from "@/components/ui/form/TextInput";
import {
  createOnePanelClient,
  type OnePanelAcmeAccount,
  type OnePanelDnsAccount,
  type OnePanelClient,
  type OnePanelSslProvider,
  type OnePanelWebsiteSslCreate,
  type OnePanelWebsiteSslUpdate,
} from "@/lib/onepanel";
import { showToast } from "@/stores/toastStore";
import { useServerPanelCacheStore } from "@/stores/serverPanelCacheStore";
import type { ServerEntry } from "./serverConnection";

type CreateMode = "apply" | "upload";

const KEY_TYPES = ["P256", "P384", "2048", "3072", "4096"] as const;
const PROVIDERS: OnePanelSslProvider[] = ["dnsAccount", "dnsManual", "http"];
const SSL_SUCCESS_STATUSES = new Set(["success", "ready"]);
const SSL_ERROR_STATUSES = new Set(["error", "applyError", "applyerror"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isSslApplySuccess(status: string): boolean {
  return SSL_SUCCESS_STATUSES.has(status.trim().toLowerCase());
}

function isSslApplyError(status: string): boolean {
  return SSL_ERROR_STATUSES.has(status.trim().toLowerCase());
}

type CreateCertificateDialogProps = {
  open: boolean;
  server: ServerEntry;
  /** 传入时进入编辑模式（POST /websites/ssl/update） */
  editId?: number | null;
  onClose: () => void;
  onCreated?: () => void;
};

function formatCreateError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  return String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallback;
}

function normalizeProvider(value: unknown): string {
  const raw = asString(value, "dnsAccount");
  if (PROVIDERS.includes(raw as OnePanelSslProvider)) return raw;
  return raw || "dnsAccount";
}

export function CreateCertificateDialog({
  open,
  server,
  editId = null,
  onClose,
  onCreated,
}: CreateCertificateDialogProps) {
  const { t } = useI18n();
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);
  const isEdit = editId != null && editId > 0;

  const [mode, setMode] = useState<CreateMode>("apply");

  // apply (POST /websites/ssl) / update
  const [primaryDomain, setPrimaryDomain] = useState("");
  const [otherDomains, setOtherDomains] = useState("");
  const [provider, setProvider] = useState<string>("dnsAccount");
  const [acmeAccountId, setAcmeAccountId] = useState(0);
  const [dnsAccountId, setDnsAccountId] = useState(0);
  const [autoRenew, setAutoRenew] = useState(true);
  const [keyType, setKeyType] = useState<string>("P256");
  const [description, setDescription] = useState("");

  // upload (POST /websites/ssl/upload)
  const [certificate, setCertificate] = useState("");
  const [privateKey, setPrivateKey] = useState("");

  const [acmeAccounts, setAcmeAccounts] = useState<OnePanelAcmeAccount[]>([]);
  const [dnsAccounts, setDnsAccounts] = useState<OnePanelDnsAccount[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyLog, setApplyLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortApplyRef = useRef(false);
  const logEndRef = useRef<HTMLPreElement | null>(null);

  const reset = useCallback(() => {
    abortApplyRef.current = true;
    setMode("apply");
    setPrimaryDomain("");
    setOtherDomains("");
    setProvider("dnsAccount");
    setAcmeAccountId(0);
    setDnsAccountId(0);
    setAutoRenew(true);
    setKeyType("P256");
    setDescription("");
    setCertificate("");
    setPrivateKey("");
    setApplyLog("");
    setApplying(false);
    setError(null);
    setBusy(false);
  }, []);

  const handleClose = () => {
    if (busy || applying) return;
    reset();
    onClose();
  };

  useEffect(() => {
    if (!applyLog || !logEndRef.current) return;
    logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
  }, [applyLog]);

  /** 轮询 POST /files/read/ssl?operateNode=local，直到证书状态成功/失败。 */
  const pollSslApplyLog = useCallback(
    async (client: OnePanelClient, sslId: number) => {
      abortApplyRef.current = false;
      setApplying(true);
      setApplyLog(t("server.create.certificate.applyLogWaiting"));

      for (;;) {
        if (abortApplyRef.current) {
          throw new Error(t("server.create.certificate.applyCancelled"));
        }

        const [logResult, detail] = await Promise.all([
          client.readSslLog({ id: sslId, latest: true }),
          client.getSslById(sslId),
        ]);

        const content = (logResult.content || "").trim();
        if (content) {
          setApplyLog(content);
        }

        const status = String(detail.status ?? "").trim();
        if (isSslApplySuccess(status)) {
          return;
        }
        if (isSslApplyError(status)) {
          const message =
            typeof detail.message === "string" && detail.message.trim()
              ? detail.message.trim()
              : t("server.create.certificate.applyFailed");
          throw new Error(message);
        }

        // 日志已结束但状态尚未落盘时再查一次详情
        if (logResult.end) {
          const again = await client.getSslById(sslId);
          const againStatus = String(again.status ?? "").trim();
          if (isSslApplySuccess(againStatus)) return;
          if (isSslApplyError(againStatus)) {
            const message =
              typeof again.message === "string" && again.message.trim()
                ? again.message.trim()
                : t("server.create.certificate.applyFailed");
            throw new Error(message);
          }
        }

        await sleep(2000);
      }
    },
    [t],
  );

  useEffect(() => {
    if (!open || server.serviceType !== "1panel") return;
    let cancelled = false;
    setOptionsLoading(true);
    void (async () => {
      try {
        const client = createOnePanelClient(server.address, server.key);
        const [acmeList, dnsList] = await Promise.all([
          client.searchAcmeAccounts().catch(() => [] as OnePanelAcmeAccount[]),
          client.searchDnsAccounts().catch(() => [] as OnePanelDnsAccount[]),
        ]);
        if (cancelled) return;
        setAcmeAccounts(acmeList);
        setDnsAccounts(dnsList);

        if (isEdit && editId != null) {
          setMode("apply");
          const detail = await client.getSslById(editId);
          if (cancelled) return;
          setPrimaryDomain(asString(detail.primaryDomain ?? detail.primary_domain));
          setOtherDomains(asString(detail.otherDomains ?? detail.domains));
          setProvider(normalizeProvider(detail.provider));
          setAcmeAccountId(asNumber(detail.acmeAccountId ?? detail.acmeAccountID, acmeList[0]?.id ?? 0));
          setDnsAccountId(asNumber(detail.dnsAccountId ?? detail.dnsAccountID, dnsList[0]?.id ?? 0));
          setAutoRenew(asBool(detail.autoRenew, true));
          setKeyType(asString(detail.keyType, "P256"));
          setDescription(asString(detail.description));
        } else {
          setAcmeAccountId(acmeList[0]?.id ?? 0);
          setDnsAccountId(dnsList[0]?.id ?? 0);
        }
      } catch (err) {
        if (!cancelled) setError(formatCreateError(err));
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server, isEdit, editId]);

  const providerKnown = PROVIDERS.includes(provider as OnePanelSslProvider);

  const canSubmit = useMemo(() => {
    if (isEdit) {
      if (!primaryDomain.trim()) return false;
      if (providerKnown && !acmeAccountId) return false;
      if (provider === "dnsAccount" && !dnsAccountId) return false;
      return true;
    }
    if (mode === "upload") {
      return Boolean(certificate.trim() && privateKey.trim());
    }
    if (!primaryDomain.trim() || !acmeAccountId) return false;
    if (provider === "dnsAccount" && !dnsAccountId) return false;
    return true;
  }, [
    isEdit,
    mode,
    certificate,
    privateKey,
    primaryDomain,
    acmeAccountId,
    provider,
    dnsAccountId,
    providerKnown,
  ]);

  const handleSubmit = async () => {
    if (server.serviceType !== "1panel") {
      setError(t("server.create.onePanelOnly"));
      return;
    }
    if (!canSubmit) {
      setError(t("server.create.certificate.required"));
      return;
    }

    setBusy(true);
    setError(null);
    abortApplyRef.current = false;
    try {
      const client = createOnePanelClient(server.address, server.key);

      if (isEdit && editId != null) {
        const body: OnePanelWebsiteSslUpdate = {
          id: editId,
          primaryDomain: primaryDomain.trim(),
          otherDomains: otherDomains.trim(),
          provider,
          acmeAccountId: acmeAccountId || undefined,
          dnsAccountId: provider === "dnsAccount" ? dnsAccountId : 0,
          autoRenew,
          keyType,
          description: description.trim(),
          apply: false,
          pushDir: false,
          dir: "",
          disableCNAME: false,
          skipDNS: false,
          nameserver1: "",
          nameserver2: "",
          execShell: false,
          shell: "",
        };
        await client.updateWebsiteSsl(body);
        showToast(t("server.certificates.editSuccess"));
        await refreshServer(server);
        reset();
        onClose();
        onCreated?.();
        return;
      }

      if (mode === "upload") {
        await client.uploadWebsiteSsl({
          type: "paste",
          certificate: certificate.trim(),
          privateKey: privateKey.trim(),
          privateKeyPath: "",
          certificatePath: "",
          sslID: 0,
          description: description.trim(),
        });
        showToast(t("server.create.certificate.uploadSuccess"));
        await refreshServer(server);
        reset();
        onClose();
        onCreated?.();
        return;
      }

      const shouldApply = provider !== "dnsManual";
      const body: OnePanelWebsiteSslCreate = {
        primaryDomain: primaryDomain.trim(),
        otherDomains: otherDomains.trim(),
        provider: provider as OnePanelSslProvider,
        acmeAccountId,
        dnsAccountId: provider === "dnsAccount" ? dnsAccountId : 0,
        autoRenew,
        keyType,
        description: description.trim(),
        apply: shouldApply,
        pushDir: false,
        dir: "",
        disableCNAME: false,
        skipDNS: false,
        nameserver1: "",
        nameserver2: "",
        execShell: false,
        shell: "",
      };
      const created = await client.createWebsiteSsl(body);

      if (!shouldApply) {
        showToast(t("server.create.certificate.applyManualSuccess"));
        await refreshServer(server);
        reset();
        onClose();
        onCreated?.();
        return;
      }

      // 申请中：底部展示 /files/read/ssl 日志，成功后再关弹窗
      await pollSslApplyLog(client, created.id);
      showToast(t("server.create.certificate.applySuccess"));
      await refreshServer(server);
      reset();
      onClose();
      onCreated?.();
    } catch (err) {
      if (!abortApplyRef.current) {
        setError(formatCreateError(err));
      }
    } finally {
      setApplying(false);
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={
        isEdit ? t("server.certificates.editTitle") : t("server.create.certificate.title")
      }
      size="xl"
      clipboardAssist={false}
      cancelDisabled={busy || applying}
      closeDisabled={busy || applying}
      primaryAction={{
        label: applying
          ? t("server.create.certificate.applying")
          : busy
            ? t("common.saving")
            : t("common.confirm"),
        disabled: busy || applying || !canSubmit || optionsLoading,
        onClick: () => void handleSubmit(),
      }}
      status={error ? { kind: "error", message: error } : null}
      bodyClassName="server-create-split"
    >
      {!isEdit ? (
        <nav className="server-create-split__nav" aria-label={t("server.create.certificate.mode")}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "apply"}
            className={`server-create-split__nav-item${mode === "apply" ? " is-active" : ""}`}
            disabled={busy || applying}
            onClick={() => setMode("apply")}
          >
            {t("server.create.certificate.modeApply")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "upload"}
            className={`server-create-split__nav-item${mode === "upload" ? " is-active" : ""}`}
            disabled={busy || applying}
            onClick={() => setMode("upload")}
          >
            {t("server.create.certificate.modeUpload")}
          </button>
        </nav>
      ) : null}

      <div className="server-create-split__main" role="tabpanel">
        {mode === "apply" || isEdit ? (
          <>
            <FormField label={t("server.create.certificate.primaryDomain")}>
              <TextInput
                value={primaryDomain}
                onChange={setPrimaryDomain}
                placeholder="example.com"
                disabled={busy || applying}
              />
            </FormField>
            <FormField
              label={t("server.create.certificate.otherDomains")}
              hint={t("server.create.certificate.otherDomainsHint")}
            >
              <textarea
                className="input server-create-textarea"
                value={otherDomains}
                onChange={(event) => setOtherDomains(event.target.value)}
                rows={3}
                disabled={busy || applying}
                placeholder={"www.example.com\napi.example.com"}
              />
            </FormField>

            {providerKnown || !isEdit ? (
              <FormField label={t("server.create.certificate.acmeAccount")}>
                <select
                  className="input"
                  value={acmeAccountId}
                  disabled={busy || applying || acmeAccounts.length === 0}
                  onChange={(e) => setAcmeAccountId(Number(e.target.value) || 0)}
                >
                  {acmeAccounts.length === 0 ? (
                    <option value={0}>{t("server.create.certificate.acmeEmpty")}</option>
                  ) : (
                    acmeAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.email}
                        {account.type ? ` (${account.type})` : ""}
                      </option>
                    ))
                  )}
                </select>
              </FormField>
            ) : null}

            <FormField label={t("server.create.certificate.provider")}>
              {providerKnown ? (
                <div className="server-create-website-types" role="tablist">
                  {PROVIDERS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={provider === key}
                      className={`server-create-website-type${provider === key ? " is-active" : ""}`}
                      disabled={busy || applying}
                      onClick={() => setProvider(key)}
                    >
                      {t(
                        `server.create.certificate.providers.${key}` as "server.create.certificate.providers.dnsAccount",
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <TextInput value={provider} onChange={setProvider} disabled={busy || applying} />
              )}
            </FormField>

            {provider === "dnsAccount" ? (
              <FormField label={t("server.create.certificate.dnsAccount")}>
                <select
                  className="input"
                  value={dnsAccountId}
                  disabled={busy || applying || dnsAccounts.length === 0}
                  onChange={(e) => setDnsAccountId(Number(e.target.value) || 0)}
                >
                  {dnsAccounts.length === 0 ? (
                    <option value={0}>{t("server.create.certificate.dnsEmpty")}</option>
                  ) : (
                    dnsAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                        {account.type ? ` (${account.type})` : ""}
                      </option>
                    ))
                  )}
                </select>
              </FormField>
            ) : null}

            {provider === "dnsManual" ? (
              <p className="form-hint">{t("server.create.certificate.dnsManualHint")}</p>
            ) : null}
            {provider === "http" ? (
              <p className="form-hint">{t("server.create.certificate.httpHint")}</p>
            ) : null}

            <FormField label={t("server.create.certificate.keyType")}>
              <select
                className="input"
                value={keyType}
                disabled={busy || applying}
                onChange={(e) => setKeyType(e.target.value)}
              >
                {KEY_TYPES.map((kt) => (
                  <option key={kt} value={kt}>
                    {kt}
                  </option>
                ))}
                {!KEY_TYPES.includes(keyType as (typeof KEY_TYPES)[number]) && keyType ? (
                  <option value={keyType}>{keyType}</option>
                ) : null}
              </select>
            </FormField>

            <label className="server-create-website-check">
              <input
                type="checkbox"
                checked={autoRenew}
                disabled={busy || applying}
                onChange={(e) => setAutoRenew(e.target.checked)}
              />
              <span>{t("server.create.certificate.autoRenew")}</span>
            </label>

            <FormField label={t("server.create.certificate.description")}>
              <TextInput
                value={description}
                onChange={setDescription}
                placeholder={t("server.create.certificate.descriptionPlaceholder")}
                disabled={busy || applying}
              />
            </FormField>
          </>
        ) : (
          <>
            <FormField label={t("server.create.certificate.description")}>
              <TextInput
                value={description}
                onChange={setDescription}
                placeholder={t("server.create.certificate.descriptionPlaceholder")}
                disabled={busy || applying}
              />
            </FormField>
            <FormField label={t("server.create.certificate.pem")}>
              <textarea
                className="input server-create-textarea"
                value={certificate}
                onChange={(event) => setCertificate(event.target.value)}
                rows={8}
                disabled={busy || applying}
                placeholder="-----BEGIN CERTIFICATE-----"
              />
            </FormField>
            <FormField label={t("server.create.certificate.key")}>
              <textarea
                className="input server-create-textarea"
                value={privateKey}
                onChange={(event) => setPrivateKey(event.target.value)}
                rows={8}
                disabled={busy || applying}
                placeholder="-----BEGIN PRIVATE KEY-----"
              />
            </FormField>
          </>
        )}

        {applyLog || applying ? (
          <div className="server-create-ssl-log">
            <div className="server-create-ssl-log__title">
              {t("server.create.certificate.applyLog")}
            </div>
            <pre ref={logEndRef} className="server-create-ssl-log__body">
              {applyLog || t("server.create.certificate.applyLogWaiting")}
            </pre>
          </div>
        ) : null}
      </div>
    </FormDialog>
  );
}
