import { useCallback, useEffect, useRef, useState } from "react";
import { FormDialog, FormField } from "../../components/ui/form/FormDialog";
import { TextInput } from "../../components/ui/form/TextInput";
import { useI18n } from "../../i18n";
import type { ProtocolTabKey } from "../../lib/protocolLabConfig";
import { useProtocolAddMenu } from "./useProtocolAddMenu";
import { createProtocolSession, defaultProtocolSessionName } from "./createProtocolSession";
import { useProtocolHttpOptional } from "./ProtocolHttpContext";
import { useProtocolTopbarStore } from "../../stores/protocolTopbarStore";
import { showToast } from "../../stores/toastStore";

interface ProtocolNewTabDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 须挂在 ProtocolHttpProvider 内，避免跨 WebView / 模块级 handler 静默失败 */
export function ProtocolNewTabDialog({ open, onOpenChange }: ProtocolNewTabDialogProps) {
  const { t } = useI18n();
  const http = useProtocolHttpOptional();
  const { menuItems } = useProtocolAddMenu();
  const pickerIntent = useProtocolTopbarStore((s) => s.pickerIntent);
  const pickerParentFolderId = useProtocolTopbarStore((s) => s.pickerParentFolderId);
  const pickerPreselectedProtocol = useProtocolTopbarStore((s) => s.pickerPreselectedProtocol);
  const isNewRequest = pickerIntent === "new-request";

  const [selectedProtocol, setSelectedProtocol] = useState<ProtocolTabKey>("http");
  const [sessionName, setSessionName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const nameTouchedRef = useRef(false);

  const resetForm = useCallback(() => {
    const fallback = (menuItems[0]?.id as ProtocolTabKey | undefined) ?? "http";
    const protocol =
      pickerPreselectedProtocol && menuItems.some((item) => item.id === pickerPreselectedProtocol)
        ? pickerPreselectedProtocol
        : fallback;
    setSelectedProtocol(protocol);
    setSessionName(defaultProtocolSessionName(protocol, t as (key: string) => string));
    setNameError(null);
    nameTouchedRef.current = false;
  }, [menuItems, pickerPreselectedProtocol, t]);

  useEffect(() => {
    if (!open) return;
    resetForm();
  }, [open, resetForm]);

  const handleProtocolSelect = useCallback(
    (protocol: ProtocolTabKey) => {
      setSelectedProtocol(protocol);
      if (!nameTouchedRef.current) {
        setSessionName(defaultProtocolSessionName(protocol, t as (key: string) => string));
      }
      setNameError(null);
    },
    [t],
  );

  const handleSubmit = useCallback(async () => {
    const trimmed = sessionName.trim();
    if (!trimmed) {
      setNameError(t("protocol.sidebar.folderNameRequired"));
      return;
    }
    setNameError(null);

    if (selectedProtocol === "http" && !http) {
      showToast(t("protocol.http.createRequestFailed"));
      return;
    }

    await createProtocolSession({
      protocol: selectedProtocol,
      name: trimmed,
      parentFolderId: pickerParentFolderId,
      http: http
        ? {
            createRequest: (name, parentFolderId) => http.createRequest(name, parentFolderId),
          }
        : null,
      t: t as (key: string) => string,
    });
    onOpenChange(false);
  }, [http, onOpenChange, pickerParentFolderId, selectedProtocol, sessionName, t]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={isNewRequest ? t("protocol.sidebar.newRequest") : t("protocol.newTab.title")}
      subtitle={t("protocol.newTab.createSessionDesc")}
      size="sm"
      className="protocol-create-session-dialog"
      bodyClassName="protocol-create-session-body"
      cancelVariant="ghost"
      primaryAction={{
        label: t("protocol.newTab.createSession"),
        onClick: () => void handleSubmit(),
      }}
    >
      <FormField label={t("protocol.newTab.sessionNameLabel")} htmlFor="protocol-session-name">
        <TextInput
          id="protocol-session-name"
          className="input"
          autoFocus
          value={sessionName}
          placeholder={t("protocol.newTab.sessionNamePlaceholder")}
          onChange={(value) => {
            nameTouchedRef.current = true;
            setSessionName(value);
            if (nameError && value.trim()) {
              setNameError(null);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleSubmit();
            }
          }}
        />
      </FormField>
      {nameError ? <div className="form-error">{nameError}</div> : null}

      <div className="form-field">
        <span id="protocol-session-type-label" className="form-label">
          {t("protocol.newTab.selectProtocolLabel")}
        </span>
        <div
          className="form-choice-list"
          role="radiogroup"
          aria-labelledby="protocol-session-type-label"
        >
          {menuItems.map((item) => {
            const protocol = item.id as ProtocolTabKey;
            const selected = selectedProtocol === protocol;
            return (
              <label
                key={item.id}
                className={`form-choice-item${selected ? " form-choice-item--selected" : ""}`}
              >
                <input
                  type="radio"
                  name="protocol-session-type"
                  value={protocol}
                  checked={selected}
                  onChange={() => handleProtocolSelect(protocol)}
                />
                <span className="form-choice-item__body">
                  <span className="form-choice-item__label">{item.label}</span>
                  {item.subtitle ? (
                    <span className="form-choice-item__hint">{item.subtitle}</span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </FormDialog>
  );
}

/** 订阅 store 开关；挂在 ProtocolPanel / Provider 内即可主窗与独立窗共用 */
export function ProtocolNewTabDialogHost() {
  const open = useProtocolTopbarStore((s) => s.newTabPickerOpen);
  const setOpen = useProtocolTopbarStore((s) => s.setNewTabPickerOpen);
  return <ProtocolNewTabDialog open={open} onOpenChange={setOpen} />;
}
