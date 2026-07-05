import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Select, type SelectOption } from "../ui/form/Select";
import {
  clearSystemFontCache,
  detectAllSystemFonts,
  detectMonospaceFonts,
  MONOSPACE_FONT_CANDIDATES,
} from "../../lib/systemFonts";
import { useI18n } from "../../i18n";

export interface FontFamilySelectProps {
  value: string;
  onChange: (fontFamily: string) => void;
  /** 仅列出等宽字体（终端 / SQL 编辑器等） */
  monospaceOnly?: boolean;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  placeholder?: string;
  "aria-label"?: string;
}

function fontPreviewStyle(fontFamily: string): CSSProperties {
  return { fontFamily: `"${fontFamily}", var(--font-ui)` };
}

function fallbackFonts(monospaceOnly: boolean, value: string): string[] {
  const base = monospaceOnly
    ? [...MONOSPACE_FONT_CANDIDATES]
    : [...MONOSPACE_FONT_CANDIDATES, "Segoe UI", "Arial", "Microsoft YaHei", "SimSun"];
  if (value.trim() && !base.includes(value)) {
    return [value.trim(), ...base];
  }
  return base;
}

export function FontFamilySelect({
  value,
  onChange,
  monospaceOnly = false,
  disabled = false,
  className,
  size = "sm",
  placeholder,
  "aria-label": ariaLabel,
}: FontFamilySelectProps) {
  const { t } = useI18n();
  const [fonts, setFonts] = useState<string[]>(() => fallbackFonts(monospaceOnly, value));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const loadFonts = useCallback(
    async (force = false) => {
      if (force) {
        clearSystemFontCache();
      }
      setLoading(true);
      setLoadError(false);
      try {
        const detect = monospaceOnly ? detectMonospaceFonts : detectAllSystemFonts;
        const detected = await detect(value);
        setFonts(detected.length > 0 ? detected : fallbackFonts(monospaceOnly, value));
      } catch {
        setLoadError(true);
        setFonts(fallbackFonts(monospaceOnly, value));
      } finally {
        setLoading(false);
      }
    },
    [monospaceOnly, value],
  );

  useEffect(() => {
    void loadFonts();
  }, [loadFonts]);

  useEffect(() => {
    if (!value.trim()) return;
    setFonts((prev) => {
      if (prev.includes(value)) return prev;
      return [value, ...prev].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    });
  }, [value]);

  const options = useMemo<SelectOption[]>(
    () =>
      fonts.map((font) => ({
        value: font,
        label: font,
        labelStyle: fontPreviewStyle(font),
      })),
    [fonts],
  );

  const wrapperStyle = useMemo(
    () =>
      ({
        "--font-family-select-value": `"${value}"`,
      }) as CSSProperties,
    [value],
  );

  const displayPlaceholder = loading
    ? t("common.loading")
    : loadError
      ? placeholder
      : placeholder;

  return (
    <div className="font-family-select" style={wrapperStyle}>
      <Select
        className={className}
        size={size}
        value={value}
        onChange={onChange}
        options={options}
        disabled={disabled}
        searchable
        placeholder={displayPlaceholder}
        emptyText={loadError ? t("ui.fontSelect.loadFailed") : undefined}
        aria-label={ariaLabel}
      />
      {loadError ? (
        <button
          type="button"
          className="font-family-select__retry"
          onClick={() => void loadFonts(true)}
        >
          {t("ui.fontSelect.retry")}
        </button>
      ) : null}
    </div>
  );
}
