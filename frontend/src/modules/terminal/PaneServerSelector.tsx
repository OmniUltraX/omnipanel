import { Select, type SelectOption } from "../../components/ui/Select";
import { useI18n } from "../../i18n";

export type PaneServerOption = SelectOption;

type PaneServerSelectorProps = {
  value: string;
  options: PaneServerOption[];
  onChange: (resourceId: string) => void;
  disabled?: boolean;
};

/** 终端窗格服务器选择（基于统一 Select 组件） */
export function PaneServerSelector({
  value,
  options,
  onChange,
  disabled,
}: PaneServerSelectorProps) {
  const { t } = useI18n();

  return (
    <Select
      className="term-pane-server-select"
      size="sm"
      borderless
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      searchable
      searchThreshold={4}
      aria-label={t("terminal.pane.server")}
      title={t("terminal.pane.server")}
    />
  );
}
