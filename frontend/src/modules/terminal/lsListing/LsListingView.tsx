import { memo, useCallback, useMemo, type CSSProperties } from "react";
import type { LsEntry, LsListing } from "./parseLsListing";
import { joinListingEntryPath } from "./resolveLsListingDirectory";
import { terminalCdCommand } from "../terminalPathCrumbs";
import {
  layoutLsGrid,
  lsEntryDisplayName,
  LS_GRID_COLUMN_GAP,
} from "./layoutLsGrid";
import { useLsGridTerminalWidth } from "./useLsGridTerminalWidth";
import {
  computeLongFieldWidths,
  detectLongFieldFormat,
  longFormatSizeFieldIndex,
  padLongField,
  type LongFieldFormat,
} from "./formatLongFields";

type LongColumnWidths = {
  prefix: number;
  size: number;
  trailing: number;
  hasSize: boolean;
  hasTrailing: boolean;
};

function computeLongColumnWidths(entries: LsEntry[]): LongColumnWidths {
  let prefix = 0;
  let size = 0;
  let trailing = 0;
  let hasSize = false;
  let hasTrailing = false;

  for (const entry of entries) {
    if (entry.longDetail) {
      prefix = Math.max(prefix, entry.longDetail.length);
    }
    if (entry.longSize !== undefined) {
      hasSize = true;
      size = Math.max(size, entry.longSize.length);
    }
    if (entry.longTrailing) {
      hasTrailing = true;
      trailing = Math.max(trailing, entry.longTrailing.length);
    }
  }

  if (hasSize) {
    size = Math.max(size, 1);
  }

  return { prefix, size, trailing, hasSize, hasTrailing };
}

type LsListingViewProps = {
  listing: LsListing;
  listingDirectory: string;
  onRunCommand?: (command: string) => void;
};

const KIND_CLASS: Record<LsEntry["kind"], string> = {
  directory: "term-ls-entry--dir",
  symlink: "term-ls-entry--link",
  executable: "term-ls-entry--exec",
  archive: "term-ls-entry--archive",
  image: "term-ls-entry--image",
  media: "term-ls-entry--media",
  code: "term-ls-entry--code",
  config: "term-ls-entry--config",
  file: "term-ls-entry--file",
};

function isLsEntryNavigable(entry: LsEntry): boolean {
  return entry.navigable ?? entry.kind === "directory";
}

function LsEntryName({
  entry,
  className,
  title,
  onRunCommand,
  cdCommand,
}: {
  entry: LsEntry;
  className: string;
  title: string;
  onRunCommand?: (command: string) => void;
  cdCommand: string;
}) {
  const navigable = isLsEntryNavigable(entry);
  const displayName = lsEntryDisplayName(entry);

  const handleClick = useCallback(() => {
    if (!navigable || !onRunCommand) return;
    onRunCommand(cdCommand);
  }, [navigable, onRunCommand, cdCommand]);

  if (navigable) {
    return (
      <button type="button" className={className} title={title} onClick={handleClick}>
        {displayName}
      </button>
    );
  }

  return (
    <span className={className} title={title}>
      {displayName}
    </span>
  );
}

function LsLongRow({
  entry,
  listingDirectory,
  fieldWidths,
  fieldFormat,
  legacyWidths,
  onRunCommand,
}: {
  entry: LsEntry;
  listingDirectory: string;
  fieldWidths: number[] | null;
  fieldFormat: LongFieldFormat;
  legacyWidths: LongColumnWidths;
  onRunCommand?: (command: string) => void;
}) {
  const navigable = isLsEntryNavigable(entry);
  const className = `term-ls-entry ${KIND_CLASS[entry.kind]}${navigable ? " term-ls-entry--clickable" : ""}`;
  const absolutePath = joinListingEntryPath(listingDirectory, entry.name);
  const cdCommand = terminalCdCommand(absolutePath);

  const nameNode = (
    <LsEntryName
      entry={entry}
      className={className}
      title={navigable ? cdCommand : entry.name}
      onRunCommand={onRunCommand}
      cdCommand={cdCommand}
    />
  );

  if (!entry.longDetail && entry.longSize === undefined && !entry.longTrailing && !entry.longFields) {
    return (
      <div className="term-ls-long-row" role="listitem">
        {nameNode}
      </div>
    );
  }

  if (entry.longFields && entry.longFields.length > 0 && fieldWidths) {
    const sizeIndex = longFormatSizeFieldIndex(fieldFormat);
    return (
      <div className="term-ls-long-row" role="listitem">
        {entry.longFields.map((field, index) => (
          <span
            key={`${entry.name}-field-${index}`}
            className={`term-ls-long-row__field${
              index === sizeIndex ? " term-ls-long-row__field--size" : ""
            }`}
          >
            {padLongField(field, index, fieldWidths[index] ?? field.length, fieldFormat)}
          </span>
        ))}
        <span className="term-ls-long-row__name">{nameNode}</span>
      </div>
    );
  }

  const useStructured =
    legacyWidths.hasSize || legacyWidths.hasTrailing || entry.longSize !== undefined;

  if (!useStructured && entry.longDetail) {
    return (
      <div className="term-ls-long-row" role="listitem">
        <span className="term-ls-long-row__meta">{entry.longDetail}</span>
        <span className="term-ls-long-row__name">{nameNode}</span>
      </div>
    );
  }

  const prefix =
    legacyWidths.prefix > 0
      ? (entry.longDetail ?? "").padEnd(legacyWidths.prefix, " ")
      : (entry.longDetail ?? "");
  const sizeText = legacyWidths.hasSize
    ? (entry.longSize ?? "").padStart(legacyWidths.size, " ")
    : "";
  const trailing =
    legacyWidths.hasTrailing && entry.longTrailing
      ? entry.longTrailing.padEnd(legacyWidths.trailing, " ")
      : (entry.longTrailing ?? "");

  return (
    <div className="term-ls-long-row" role="listitem">
      {prefix ? <span className="term-ls-long-row__prefix">{prefix}</span> : null}
      {legacyWidths.hasSize ? (
        <span className="term-ls-long-row__size">{sizeText}</span>
      ) : null}
      {trailing ? <span className="term-ls-long-row__trailing">{trailing}</span> : null}
      <span className="term-ls-long-row__name">{nameNode}</span>
    </div>
  );
}

function LsGridColumnView({
  column,
  listingDirectory,
  onRunCommand,
}: {
  column: { entries: LsEntry[]; width: number };
  listingDirectory: string;
  onRunCommand?: (command: string) => void;
}) {
  return (
    <div
      className="term-ls-grid-column"
      style={{ width: `${column.width + LS_GRID_COLUMN_GAP}ch` }}
    >
      {column.entries.map((entry, rowIndex) => {
        const navigable = isLsEntryNavigable(entry);
        const className = `term-ls-entry ${KIND_CLASS[entry.kind]}${navigable ? " term-ls-entry--clickable" : ""}`;
        const absolutePath = joinListingEntryPath(listingDirectory, entry.name);
        const cdCommand = terminalCdCommand(absolutePath);

        return (
          <div className="term-ls-grid-row" key={`${entry.name}-${rowIndex}`} role="listitem">
            <LsEntryName
              entry={entry}
              className={className}
              title={navigable ? cdCommand : entry.name}
              onRunCommand={onRunCommand}
              cdCommand={cdCommand}
            />
          </div>
        );
      })}
    </div>
  );
}

function LsListingViewInner({ listing, listingDirectory, onRunCommand }: LsListingViewProps) {
  const isGrid = listing.layout === "grid";
  const { containerRef, widthCh } = useLsGridTerminalWidth(isGrid);

  const legacyWidths = useMemo(
    () => (listing.layout === "long" ? computeLongColumnWidths(listing.entries) : null),
    [listing.layout, listing.entries],
  );

  const longFieldFormat = useMemo(
    () => (listing.layout === "long" ? detectLongFieldFormat(listing.entries) : "unix"),
    [listing.layout, listing.entries],
  );

  const longFieldWidths = useMemo(() => {
    if (listing.layout !== "long") return null;
    if (!listing.entries.some((e) => e.longFields?.length)) return null;
    return computeLongFieldWidths(listing.entries, longFieldFormat);
  }, [listing.layout, listing.entries, longFieldFormat]);

  const gridLayout = useMemo(
    () => (isGrid ? layoutLsGrid(listing.entries, widthCh) : null),
    [isGrid, listing.entries, widthCh],
  );

  const style: CSSProperties | undefined = useMemo(() => {
    if (listing.layout === "long" && legacyWidths && !longFieldWidths) {
      const vars: Record<string, string> = {};
      if (legacyWidths.prefix > 0) vars["--ls-prefix-width"] = `${legacyWidths.prefix}ch`;
      if (legacyWidths.hasSize) vars["--ls-size-width"] = `${legacyWidths.size}ch`;
      if (legacyWidths.hasTrailing) vars["--ls-trailing-width"] = `${legacyWidths.trailing}ch`;
      return vars as CSSProperties;
    }
    return undefined;
  }, [listing.layout, legacyWidths, longFieldWidths]);

  if (listing.layout === "grid" && gridLayout) {
    return (
      <div
        ref={containerRef}
        className="term-ls-listing term-ls-listing--grid"
        role="list"
        aria-label="目录列表"
      >
        {gridLayout.columns.map((column, index) => (
          <LsGridColumnView
            key={`col-${index}`}
            column={column}
            listingDirectory={listingDirectory}
            onRunCommand={onRunCommand}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`term-ls-listing term-ls-listing--${listing.layout}`}
      style={style}
      role="list"
      aria-label="目录列表"
    >
      {listing.entries.map((entry, index) => (
        <LsLongRow
          key={`${entry.name}-${index}`}
          entry={entry}
          listingDirectory={listingDirectory}
          fieldWidths={longFieldWidths}
          fieldFormat={longFieldFormat}
          legacyWidths={legacyWidths ?? computeLongColumnWidths([entry])}
          onRunCommand={onRunCommand}
        />
      ))}
    </div>
  );
}

export const LsListingView = memo(LsListingViewInner);
