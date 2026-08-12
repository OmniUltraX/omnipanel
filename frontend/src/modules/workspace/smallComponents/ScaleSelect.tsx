import { useMemo } from "react";
import { Select, type SelectOption } from "../../../components/ui/form/Select";
import { useI18n } from "../../../i18n";
import type { HomeCustomPanelWidget } from "./types";
import {
  DEFAULT_WIDGET_SCALE,
  WIDGET_SCALE_FACTORS,
  normalizeWidgetScale,
  type WidgetScale,
} from "./widgetScale";

type Props = {
  widget: HomeCustomPanelWidget;
  onChange: (scale: WidgetScale) => void;
  className?: string;
  disabled?: boolean;
  borderless?: boolean;
};

/** 小组件等比缩放：1× / 2× */
export function SmallComponentScaleSelect({
  widget,
  onChange,
  className,
  disabled,
  borderless = true,
}: Props) {
  const { t } = useI18n();
  const value = normalizeWidgetScale(widget.scale ?? DEFAULT_WIDGET_SCALE);
  const options = useMemo<SelectOption[]>(
    () =>
      WIDGET_SCALE_FACTORS.map((factor) => ({
        value: String(factor),
        label: t(
          factor === 1
            ? "homeWorkspace.customPanel.scale1x"
            : "homeWorkspace.customPanel.scale2x",
        ),
      })),
    [t],
  );

  return (
    <Select
      size="sm"
      borderless={borderless}
      disabled={disabled}
      className={["home-custom-panel-widget__scale-select", className]
        .filter(Boolean)
        .join(" ")}
      value={String(value)}
      onChange={(next) => {
        const scale = normalizeWidgetScale(next);
        if (scale !== value) onChange(scale);
      }}
      aria-label={t("homeWorkspace.customPanel.selectScale")}
      options={options}
      panelMinWidth={72}
    />
  );
}
