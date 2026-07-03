import { useCallback } from "react";
import { JsonView } from "react-json-view-lite";
import type { StyleProps } from "react-json-view-lite/dist/DataRenderer";
import "react-json-view-lite/dist/index.css";
import "./VirtualJsonView.css";
import { cn } from "../../lib/utils";

export interface VirtualJsonViewProps {
  value: object;
  className?: string;
  expandLevel?: number;
}

const customStyles: StyleProps = {
  container: "json-view-container",
  basicChildStyle: "json-view-child",
  label: "json-view-label",
  clickableLabel: "json-view-label-clickable",
  nullValue: "json-view-null",
  undefinedValue: "json-view-undefined",
  numberValue: "json-view-number",
  stringValue: "json-view-string",
  booleanValue: "json-view-boolean",
  otherValue: "json-view-other",
  punctuation: "json-view-punctuation",
  expandIcon: "json-view-expand-icon",
  collapseIcon: "json-view-collapse-icon",
  collapsedContent: "json-view-collapsed-content",
  childFieldsContainer: "json-view-child-fields",
  ariaLables: {
    collapseJson: "Collapse JSON",
    expandJson: "Expand JSON",
  },
  noQuotesForStringValues: false,
  quotesForFieldNames: true,
  stringifyStringValues: false,
};

export function VirtualJsonView({
  value,
  className,
  expandLevel = 1,
}: VirtualJsonViewProps) {
  const shouldExpandNode = useCallback(
    (level: number) => level < expandLevel,
    [expandLevel],
  );

  return (
    <div className={cn("virtual-json-view", className)}>
      <JsonView
        data={value}
        style={customStyles}
        shouldExpandNode={shouldExpandNode}
        clickToExpandNode
      />
    </div>
  );
}
