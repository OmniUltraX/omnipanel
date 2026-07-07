import { useState } from "react";
import { IconGlobe } from "../../components/ui/icons/Icons";
import { useI18n } from "../../i18n";
import { useProtocolHttp } from "./ProtocolHttpContext";
import { HttpEnvironmentManageDialog } from "./HttpEnvironmentManageDialog";

export function ProtocolEnvironmentHeaderButton() {
  const { t } = useI18n();
  const http = useProtocolHttp();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="module-mode-icon-rail__btn"
        title={t("protocol.environment.manageTitle")}
        aria-label={t("protocol.environment.manageTitle")}
        onClick={() => setOpen(true)}
      >
        <IconGlobe size={16} />
      </button>
      <HttpEnvironmentManageDialog
        open={open}
        onClose={() => setOpen(false)}
        environments={http.environments}
        onSave={http.saveEnvironment}
        onDelete={http.deleteEnvironment}
      />
    </>
  );
}
