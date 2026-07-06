import { Button } from "../../../components/ui/primitives/Button";
import { IconRefresh } from "../../../components/ui/Icons";
import { useI18n } from "../../../i18n";

interface DbPanelMetaRefreshButtonProps {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}

export function DbPanelMetaRefreshButton({
  onClick,
  disabled,
  busy,
}: DbPanelMetaRefreshButtonProps) {
  const { t } = useI18n();
  const label = t("database.sidebar.refresh");

  return (
    <Button
      type="button"
      variant="icon"
      size="icon-xs"
      className="db-tables-panel-meta-refresh-btn"
      title={label}
      aria-label={label}
      disabled={disabled || busy}
      onClick={onClick}
    >
      <IconRefresh size={14} />
    </Button>
  );
}
