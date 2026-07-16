import { useCallback, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { TextInput } from "@/components/ui/form/TextInput";
import { createOnePanelClient } from "@/lib/onepanel";
import { showToast } from "@/stores/toastStore";
import { useServerPanelCacheStore } from "@/stores/serverPanelCacheStore";
import type { ServerEntry } from "./serverConnection";

function formatCreateError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function aliasFromDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\./g, "_")
    .slice(0, 64);
}

type CreateWebsiteDialogProps = {
  open: boolean;
  server: ServerEntry;
  onClose: () => void;
  onCreated?: () => void;
};

export function CreateWebsiteDialog({ open, server, onClose, onCreated }: CreateWebsiteDialogProps) {
  const { t } = useI18n();
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);
  const [domain, setDomain] = useState("");
  const [alias, setAlias] = useState("");
  const [port, setPort] = useState("80");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setDomain("");
    setAlias("");
    setPort("80");
    setError(null);
    setBusy(false);
  }, []);

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const handleDomainChange = (value: string) => {
    setDomain(value);
    if (!alias.trim() || alias === aliasFromDomain(domain)) {
      setAlias(aliasFromDomain(value));
    }
  };

  const handleSubmit = async () => {
    const primaryDomain = domain.trim();
    const siteAlias = (alias.trim() || aliasFromDomain(primaryDomain)).trim();
    const sitePort = Number(port) || 80;
    if (!primaryDomain || !siteAlias) {
      setError(t("server.create.website.required"));
      return;
    }
    if (server.serviceType !== "1panel") {
      setError(t("server.create.onePanelOnly"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = createOnePanelClient(server.address, server.key);
      await client.createWebsite({
        type: "static",
        alias: siteAlias,
        remark: "",
        appType: "installed",
        appInstallId: 0,
        webSiteGroupId: 1,
        proxy: "",
        proxyType: "",
        ftpUser: "",
        ftpPassword: "",
        taskID: crypto.randomUUID(),
        enableSSL: false,
        domains: [{ domain: primaryDomain, port: sitePort, ssl: false }],
      });
      await refreshServer(server);
      showToast(t("server.create.website.success"));
      reset();
      onClose();
      onCreated?.();
    } catch (err) {
      setError(formatCreateError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={t("server.create.website.title")}
      size="sm"
      clipboardAssist={false}
      cancelDisabled={busy}
      closeDisabled={busy}
      primaryAction={{
        label: busy ? t("common.saving") : t("common.confirm"),
        disabled: busy || !domain.trim(),
        onClick: () => void handleSubmit(),
      }}
      status={error ? { kind: "error", message: error } : null}
    >
      <FormField label={t("server.create.website.domain")}>
        <TextInput
          value={domain}
          onChange={handleDomainChange}
          placeholder="example.com"
          disabled={busy}
        />
      </FormField>
      <FormField label={t("server.create.website.alias")} hint={t("server.create.website.aliasHint")}>
        <TextInput value={alias} onChange={setAlias} disabled={busy} />
      </FormField>
      <FormField label={t("server.create.website.port")}>
        <TextInput value={port} onChange={setPort} placeholder="80" disabled={busy} />
      </FormField>
    </FormDialog>
  );
}

type CreateCertificateDialogProps = {
  open: boolean;
  server: ServerEntry;
  onClose: () => void;
  onCreated?: () => void;
};

export function CreateCertificateDialog({
  open,
  server,
  onClose,
  onCreated,
}: CreateCertificateDialogProps) {
  const { t } = useI18n();
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);
  const [description, setDescription] = useState("");
  const [certificate, setCertificate] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setDescription("");
    setCertificate("");
    setPrivateKey("");
    setError(null);
    setBusy(false);
  }, []);

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!certificate.trim() || !privateKey.trim()) {
      setError(t("server.create.certificate.required"));
      return;
    }
    if (server.serviceType !== "1panel") {
      setError(t("server.create.onePanelOnly"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = createOnePanelClient(server.address, server.key);
      await client.uploadWebsiteSsl({
        type: "paste",
        certificate: certificate.trim(),
        privateKey: privateKey.trim(),
        privateKeyPath: "",
        certificatePath: "",
        sslID: 0,
        description: description.trim(),
      });
      await refreshServer(server);
      showToast(t("server.create.certificate.success"));
      reset();
      onClose();
      onCreated?.();
    } catch (err) {
      setError(formatCreateError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={t("server.create.certificate.title")}
      size="md"
      clipboardAssist={false}
      cancelDisabled={busy}
      closeDisabled={busy}
      primaryAction={{
        label: busy ? t("common.saving") : t("common.confirm"),
        disabled: busy || !certificate.trim() || !privateKey.trim(),
        onClick: () => void handleSubmit(),
      }}
      status={error ? { kind: "error", message: error } : null}
    >
      <FormField label={t("server.create.certificate.description")}>
        <TextInput
          value={description}
          onChange={setDescription}
          placeholder={t("server.create.certificate.descriptionPlaceholder")}
          disabled={busy}
        />
      </FormField>
      <FormField label={t("server.create.certificate.pem")}>
        <textarea
          className="input server-create-textarea"
          value={certificate}
          onChange={(event) => setCertificate(event.target.value)}
          rows={8}
          disabled={busy}
          placeholder="-----BEGIN CERTIFICATE-----"
        />
      </FormField>
      <FormField label={t("server.create.certificate.key")}>
        <textarea
          className="input server-create-textarea"
          value={privateKey}
          onChange={(event) => setPrivateKey(event.target.value)}
          rows={8}
          disabled={busy}
          placeholder="-----BEGIN PRIVATE KEY-----"
        />
      </FormField>
    </FormDialog>
  );
}

type CreateCronjobDialogProps = {
  open: boolean;
  server: ServerEntry;
  onClose: () => void;
  onCreated?: () => void;
};

export function CreateCronjobDialog({ open, server, onClose, onCreated }: CreateCronjobDialogProps) {
  const { t } = useI18n();
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);
  const [name, setName] = useState("");
  const [spec, setSpec] = useState("0 0 * * *");
  const [script, setScript] = useState("#!/bin/bash\necho hello");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setName("");
    setSpec("0 0 * * *");
    setScript("#!/bin/bash\necho hello");
    setError(null);
    setBusy(false);
  }, []);

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    const jobName = name.trim();
    const cronSpec = spec.trim();
    const shell = script.trim();
    if (!jobName || !cronSpec || !shell) {
      setError(t("server.create.cronjob.required"));
      return;
    }
    if (server.serviceType !== "1panel") {
      setError(t("server.create.onePanelOnly"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = createOnePanelClient(server.address, server.key);
      await client.createCronjob({
        id: 0,
        name: jobName,
        groupID: 0,
        type: "shell",
        specCustom: true,
        spec: cronSpec,
        specs: [cronSpec],
        scriptID: 0,
        appID: "",
        website: "",
        exclusionRules: "",
        dbType: "",
        dbName: "",
        url: "",
        isDir: false,
        sourceDir: "",
        executor: "bash",
        scriptMode: "input",
        script: shell,
        command: "",
        containerName: "",
        user: "",
        sourceAccountIDs: "",
        downloadAccountID: 0,
        retainCopies: 0,
        retryTimes: 0,
        timeout: 0,
        ignoreErr: false,
        secret: "",
        alertCount: 0,
        alertTitle: "",
        alertMethod: "",
      });
      await refreshServer(server);
      showToast(t("server.create.cronjob.success"));
      reset();
      onClose();
      onCreated?.();
    } catch (err) {
      setError(formatCreateError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={t("server.create.cronjob.title")}
      size="md"
      clipboardAssist={false}
      cancelDisabled={busy}
      closeDisabled={busy}
      primaryAction={{
        label: busy ? t("common.saving") : t("common.confirm"),
        disabled: busy || !name.trim() || !spec.trim() || !script.trim(),
        onClick: () => void handleSubmit(),
      }}
      status={error ? { kind: "error", message: error } : null}
    >
      <FormField label={t("server.create.cronjob.name")}>
        <TextInput value={name} onChange={setName} disabled={busy} />
      </FormField>
      <FormField label={t("server.create.cronjob.spec")} hint={t("server.create.cronjob.specHint")}>
        <TextInput value={spec} onChange={setSpec} placeholder="0 0 * * *" disabled={busy} />
      </FormField>
      <FormField label={t("server.create.cronjob.script")}>
        <textarea
          className="input server-create-textarea"
          value={script}
          onChange={(event) => setScript(event.target.value)}
          rows={8}
          disabled={busy}
        />
      </FormField>
    </FormDialog>
  );
}
