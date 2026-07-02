import { useMemo, type MouseEvent, type ReactNode } from "react";
import type {
  ActionProps,
  CombinatorSelectorProps,
  FieldSelectorProps,
  OperatorSelectorProps,
  ValueEditorProps,
  ValueSelectorProps,
} from "react-querybuilder";
import type { Option, OptionGroup } from "@react-querybuilder/core";
import { Button } from "../../../components/ui/Button";
import { Select, type SelectOption } from "../../../components/ui/Select";
import { TextInput } from "../../../components/ui/TextInput";
import { cn } from "../../../lib/utils";

function isOptionGroup(option: Option | OptionGroup): option is OptionGroup {
  return "options" in option && Array.isArray(option.options);
}

function flattenRqbOptions(options: readonly (Option | OptionGroup)[]): SelectOption[] {
  const result: SelectOption[] = [];
  for (const item of options) {
    if (isOptionGroup(item)) {
      for (const sub of item.options) {
        result.push({
          value: String(sub.name),
          label: String(sub.label ?? sub.name),
          disabled: sub.disabled,
        });
      }
      continue;
    }
    result.push({
      value: String(item.name),
      label: String(item.label ?? item.name),
      disabled: item.disabled,
    });
  }
  return result;
}

interface OmniSelectControlProps {
  value?: string;
  handleOnChange: (value: string) => void;
  options: readonly (Option | OptionGroup)[];
  disabled?: boolean;
  className?: string;
  title?: string;
  searchable?: boolean;
}

/** QueryBuilder 弹层 z-index 为 10050，下拉需更高以免被遮挡 */
const QUERY_BUILDER_SELECT_Z_INDEX = 10100;

function QueryBuilderOmniSelect({
  value,
  handleOnChange,
  options,
  disabled,
  className,
  title,
  searchable,
}: OmniSelectControlProps) {
  const selectOptions = useMemo(() => flattenRqbOptions(options), [options]);

  return (
    <Select
      value={value ?? ""}
      onChange={handleOnChange}
      options={selectOptions}
      disabled={disabled}
      className={className}
      title={title}
      aria-label={title}
      size="sm"
      searchable={searchable}
      panelZIndex={QUERY_BUILDER_SELECT_Z_INDEX}
    />
  );
}

function resolveActionLabel({ label, disabled, disabledTranslation }: ActionProps): ReactNode {
  if (disabled && disabledTranslation?.label != null) {
    return disabledTranslation.label;
  }
  return label;
}

function resolveActionTitle({ title, disabled, disabledTranslation }: ActionProps): string | undefined {
  if (disabled && disabledTranslation?.title) {
    return disabledTranslation.title;
  }
  return title;
}

function QueryBuilderTextAction(props: ActionProps) {
  const { handleOnClick, disabled, className } = props;
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className={cn("db-query-filter-action", className)}
      title={resolveActionTitle(props)}
      disabled={disabled}
      onClick={(event: MouseEvent<HTMLButtonElement>) => handleOnClick(event)}
    >
      {resolveActionLabel(props)}
    </Button>
  );
}

function QueryBuilderRemoveAction(props: ActionProps) {
  const { handleOnClick, disabled, className } = props;
  const title = resolveActionTitle(props) ?? resolveActionLabel(props)?.toString();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn("db-query-filter-remove", className)}
      title={title}
      disabled={disabled}
      aria-label={title}
      onClick={(event: MouseEvent<HTMLButtonElement>) => handleOnClick(event)}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
      </svg>
    </Button>
  );
}

function QueryBuilderValueEditor({
  value,
  handleOnChange,
  title,
  className,
  disabled,
  type = "text",
  inputType,
  operator,
  fieldData,
  testID,
}: ValueEditorProps) {
  if (operator === "null" || operator === "notNull") {
    return null;
  }

  const inputTypeCoerced = inputType ?? type;
  const placeholder = fieldData?.placeholder ?? "";

  if (inputTypeCoerced === "checkbox") {
    return (
      <input
        data-testid={testID}
        type="checkbox"
        className={className}
        title={title}
        disabled={disabled}
        checked={Boolean(value)}
        onChange={(event) => handleOnChange(event.target.checked)}
      />
    );
  }

  const resolvedType =
    inputTypeCoerced === "bigint" || inputTypeCoerced == null ? "text" : inputTypeCoerced;

  if (resolvedType === "text") {
    return (
      <TextInput
        data-testid={testID}
        clearable={false}
        copyable={false}
        className={className}
        title={title}
        placeholder={placeholder}
        disabled={disabled}
        value={value == null ? "" : String(value)}
        onChange={(next) => handleOnChange(next)}
      />
    );
  }

  return (
    <input
      data-testid={testID}
      type={resolvedType}
      className={className}
      title={title}
      placeholder={placeholder}
      disabled={disabled}
      value={value == null ? "" : String(value)}
      onChange={(event) => handleOnChange(event.target.value)}
    />
  );
}

export function QueryBuilderFieldSelector({
  value,
  handleOnChange,
  options,
  disabled,
  className,
  title,
}: FieldSelectorProps) {
  return (
    <QueryBuilderOmniSelect
      value={value}
      handleOnChange={handleOnChange}
      options={options}
      disabled={disabled}
      className={className}
      title={title}
      searchable
    />
  );
}

export function QueryBuilderOperatorSelector({
  value,
  handleOnChange,
  options,
  disabled,
  className,
  title,
}: OperatorSelectorProps) {
  return (
    <QueryBuilderOmniSelect
      value={value}
      handleOnChange={handleOnChange}
      options={options}
      disabled={disabled}
      className={className}
      title={title}
      searchable={false}
    />
  );
}

export function QueryBuilderCombinatorSelector({
  value,
  handleOnChange,
  options,
  disabled,
  className,
  title,
}: CombinatorSelectorProps) {
  return (
    <QueryBuilderOmniSelect
      value={value}
      handleOnChange={handleOnChange}
      options={options}
      disabled={disabled}
      className={className}
      title={title}
      searchable={false}
    />
  );
}

export function QueryBuilderValueSelector({
  value,
  handleOnChange,
  options,
  disabled,
  className,
  title,
  multiple,
}: ValueSelectorProps) {
  if (multiple) {
    return (
      <select
        className={className}
        title={title}
        disabled={disabled}
        multiple
        value={value ? String(value).split(",") : []}
        onChange={(event) => {
          const selected = Array.from(event.target.selectedOptions).map((opt) => opt.value);
          handleOnChange(selected.join(","));
        }}
      >
        {flattenRqbOptions(options).map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <QueryBuilderOmniSelect
      value={value}
      handleOnChange={handleOnChange}
      options={options}
      disabled={disabled}
      className={className}
      title={title}
      searchable={options.length > 8}
    />
  );
}

function QueryBuilderLockedFieldSelector({
  value,
  className,
  title,
}: FieldSelectorProps) {
  return (
    <span
      className={cn("db-query-filter-field-label", className)}
      title={title ?? value}
    >
      {value}
    </span>
  );
}

function QueryBuilderHiddenAction() {
  return null;
}

export const tableQueryBuilderControlElements = {
  fieldSelector: QueryBuilderFieldSelector,
  operatorSelector: QueryBuilderOperatorSelector,
  combinatorSelector: QueryBuilderCombinatorSelector,
  valueSelector: QueryBuilderValueSelector,
  valueEditor: QueryBuilderValueEditor,
  addRuleAction: QueryBuilderTextAction,
  addGroupAction: QueryBuilderTextAction,
  removeRuleAction: QueryBuilderRemoveAction,
  removeGroupAction: QueryBuilderRemoveAction,
  cloneRuleAction: QueryBuilderTextAction,
  cloneGroupAction: QueryBuilderTextAction,
  lockRuleAction: QueryBuilderTextAction,
  lockGroupAction: QueryBuilderTextAction,
  muteRuleAction: QueryBuilderTextAction,
  muteGroupAction: QueryBuilderTextAction,
};

export function createTableQueryBuilderControlElements(_lockedField: string) {
  return {
    ...tableQueryBuilderControlElements,
    fieldSelector: QueryBuilderLockedFieldSelector,
    addGroupAction: QueryBuilderHiddenAction,
    removeGroupAction: QueryBuilderHiddenAction,
    cloneGroupAction: QueryBuilderHiddenAction,
    lockGroupAction: QueryBuilderHiddenAction,
    muteGroupAction: QueryBuilderHiddenAction,
  };
}
