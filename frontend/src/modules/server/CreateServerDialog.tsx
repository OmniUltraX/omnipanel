import { useEffect, useState } from "react";
import { Modal } from "../../components/ui/Modal";
import { useI18n } from "../../i18n";
import { createBtPanelClient } from "../../lib/btpanel";
import { createOnePanelClient } from "../../lib/onepanel";

export interface ServerEntry {
  id: string;
  name: string;
  address: string;
  key: string;
  serviceType: "bt" | "1panel";
  createdAt: number;
}

interface CreateServerDialogProps {
  open: boolean;
  editServer?: ServerEntry | null;
  onClose: () => void;
  onCreate: (server: ServerEntry) => void;
  onUpdate: (server: ServerEntry) => void;
}

export function CreateServerDialog({ open, editServer, onClose, onCreate, onUpdate }: CreateServerDialogProps) {
  const { t } = useI18n();
  const isEdit = !!editServer;
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [key, setKey] = useState("");
  const [serviceType, setServiceType] = useState<"bt" | "1panel">("bt");
  const [status, setStatus] = useState<{ kind: "info" | "success" | "error"; message: string } | null>(
    null,
  );
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (open && editServer) {
      setName(editServer.name);
      setAddress(editServer.address);
      setKey(editServer.key);
      setServiceType(editServer.serviceType);
    } else if (open && !editServer) {
      setName("");
      setAddress("");
      setKey("");
      setServiceType("bt");
      setStatus(null);
      setTesting(false);
    }
  }, [open, editServer]);

  const handleTest = async () => {
    if (!address.trim() || !key.trim()) {
      setStatus({
        kind: "error",
        message: !address.trim() ? t("server.create.addressRequired") : t("server.create.keyRequired"),
      });
      return;
    }
    setTesting(true);
    setStatus({ kind: "info", message: t("server.create.testing") });
    try {
      if (serviceType === "1panel") {
        const client = createOnePanelClient(address.trim(), key.trim());
        const info = await client.getDeviceBase();
        const hostname = info.hostname ?? address.trim();
        setStatus({
          kind: "success",
          message: t("server.create.testSuccess", { hostname }),
        });
      } else {
        const client = createBtPanelClient(address.trim(), key.trim());
        const info = await client.getSystemTotal();
        const hostname = info.system ?? info.version ?? address.trim();
        setStatus({
          kind: "success",
          message: t("server.create.testSuccess", { hostname }),
        });
      }
    } catch (error) {
      setStatus({
        kind: "error",
        message: t("server.create.testFailed", { error: String(error) }),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = () => {
    if (!name.trim() || !address.trim() || !key.trim()) return;
    if (isEdit && editServer) {
      onUpdate({
        ...editServer,
        name: name.trim(),
        address: address.trim(),
        key: key.trim(),
        serviceType,
      });
    } else {
      onCreate({
        id: `server-${Date.now()}`,
        name: name.trim(),
        address: address.trim(),
        key: key.trim(),
        serviceType,
        createdAt: Date.now(),
      });
    }
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose}>
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>{isEdit ? t("server.edit.title") : t("server.create.title")}</h3>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">{t("server.create.name")}</label>
            <input
              className="form-input"
              type="text"
              placeholder="my-server"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">{t("server.create.address")}</label>
            <input
              className="form-input"
              type="text"
              placeholder="192.168.1.100:8888"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">{t("server.create.key")}</label>
            <input
              className="form-input"
              type="password"
              placeholder="••••••••"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">{t("server.create.serviceType")}</label>
            <div className="form-select-group">
              <button
                type="button"
                className={`form-select-btn${serviceType === "bt" ? " active" : ""}`}
                onClick={() => setServiceType("bt")}
              >
                宝塔
              </button>
              <button
                type="button"
                className={`form-select-btn${serviceType === "1panel" ? " active" : ""}`}
                onClick={() => setServiceType("1panel")}
              >
                1Panel
              </button>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={testing}>
            {t("common.cancel")}
          </button>
          {status ? (
            <span
              className={`modal-footer-status modal-footer-status--${status.kind}`}
              title={status.message}
            >
              {status.message}
            </span>
          ) : (
            <div className="modal-footer-spacer" />
          )}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={testing || !address.trim() || !key.trim()}
            onClick={() => void handleTest()}
          >
            {testing ? t("server.create.testing") : t("server.create.test")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={testing || !name.trim() || !address.trim() || !key.trim()}
            onClick={handleSubmit}
          >
            {isEdit ? t("common.save") : t("server.create.confirm")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
