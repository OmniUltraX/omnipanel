import { useMemo } from "react";
import { Select, type SelectOption } from "../../../components/ui/form/Select";
import { useI18n } from "../../../i18n";
import { resolveWidgetSizeId } from "./formatWidgetSizeLabel";
import type {
  HomeCustomPanelWidget,
  SmallComponentDefinition,
  SmallComponentSize,
} from "./types";

/** 预设选项 value：优先 id，否则 `${h}x${w}` */
export function sizePresetValue(preset: SmallComponentSize): string {
  return preset.id ?? `${preset.h}x${preset.w}`;
}

function findPreset(
  sizes: readonly SmallComponentSize[],
  sizeId: string,
): SmallComponentSize | undefined {
  return sizes.find((s) => sizePresetValue(s) === sizeId);
}

/** 当前应选中的预设 id（与 layout / sizeId 对齐） */
export function resolveSelectedSizeValue(
  widget: HomeCustomPanelWidget,
  def: SmallComponentDefinition | undefined,
): string {
  const sizes = def?.sizes ?? [];
  if (sizes.length === 0) {
    return `${widget.layout.h}x${widget.layout.w}`;
  }
  if (widget.sizeId && findPreset(sizes, widget.sizeId)) {
    return widget.sizeId;
  }
  return (
    resolveWidgetSizeId(widget.type, sizes, widget.layout, widget.sizeId) ??
    sizePresetValue(sizes[0]!)
  );
}

type Props = {
  widget: HomeCustomPanelWidget;
  def: SmallComponentDefinition;
  onChange: (sizeId: string) => void;
  className?: string;
  disabled?: boolean;
  /** 默认 true（紧凑样式）；编辑表单传 false */
  borderless?: boolean;
};

/** 小组件：从定义 sizes 选择预制尺寸（高×宽） */
export function SmallComponentSizeSelect({
  widget,
  def,
  onChange,
  className,
  disabled,
  borderless = true,
}: Props) {
  const { t } = useI18n();
  const options = useMemo<SelectOption[]>(() => {
    return def.sizes.map((preset) => {
      const value = sizePresetValue(preset);
      // 预制尺寸只显示高×宽，不带说明文案
      return { value, label: `${preset.h}×${preset.w}` };
    });
  }, [def.sizes]);

  const value = resolveSelectedSizeValue(widget, def);

  return (
    <Select
      size="sm"
      borderless={borderless}
      disabled={disabled || options.length <= 1}
      className={["home-custom-panel-widget__size-select", className]
        .filter(Boolean)
        .join(" ")}
      value={value}
      onChange={(next) => {
        if (next && next !== value) onChange(next);
      }}
      aria-label={t("homeWorkspace.customPanel.selectSize")}
      options={options}
      panelMinWidth={88}
    />
  );
}
