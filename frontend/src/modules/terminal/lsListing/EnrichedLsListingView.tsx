import { memo, useCallback, useMemo, useRef } from "react";
import type { TerminalSessionType } from "@/stores/terminalStore";
import { useI18n } from "@/i18n";
import {
  buildFileEntryContextMenuItems,
  type FileEntryCtxLabels,
} from "@/components/sftp/buildFileEntryContextMenu";
import { useSshDetailNavigationStore } from "@/stores/sshDetailNavigationStore";
import { LsListingView } from "./LsListingView";
import type { LsEntry, LsListing } from "./parseLsListing";
import { resolveListingDirectoryForBlock } from "./resolveLsListingDirectory";
import { useSftpEnrichedLsListing } from "./useSftpEnrichedLsListing";
import { useTerminalFilePreviewStore } from "../terminalFilePreviewStore";
import { joinListingEntryPath } from "./resolveLsListingDirectory";
import { LOCAL_CONNECTION_ID } from "../../files/utils";
import { FeedSearchHighlightText } from "../FeedSearchHighlightText";
import { terminalCdCommand } from "../terminalPathCrumbs";
import {
  directoryForReveal,
  shellListDirCommand,
  shellStatCommand,
  shellViewFileCommand,
} from "./shellPathCommands";

type EnrichedLsListingViewProps = {
  listing: LsListing;
  command: string;
  cwd: string;
  sessionId: string;
  sessionType?: TerminalSessionType;
  sessionUser?: string | null;
  resourceId?: string | null;
  fallbackOutput: string;
  isError?: boolean;
  rawOutput?: string | null;
  onRunCommand?: (command: string) => void;
  highlightQuery?: string;
};

function isLsEntryNavigable(entry: LsEntry): boolean {
  return entry.navigable ?? entry.kind === "directory";
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function EnrichedLsListingViewInner({
  listing,
  command,
  cwd,
  sessionId,
  sessionType = "remote",
  sessionUser,
  resourceId,
  rawOutput,
  fallbackOutput,
  isError = false,
  onRunCommand,
  highlightQuery = "",
}: EnrichedLsListingViewProps) {
  const { t } = useI18n();
  const listingDirectory = useMemo(
    () => resolveListingDirectoryForBlock(command, cwd, sessionUser, rawOutput),
    [command, cwd, sessionUser, rawOutput],
  );

  const { listing: resolved, ready } = useSftpEnrichedLsListing(
    listing,
    command,
    cwd,
    sessionId,
    sessionType,
    sessionUser,
    resourceId,
  );
  const lastResolvedRef = useRef<LsListing | null>(null);

  const openFilePreview = useTerminalFilePreviewStore((state) => state.open);
  const revealInSftp = useSshDetailNavigationStore((s) => s.revealInSftp);
  const revealInFiles = useSshDetailNavigationStore((s) => s.revealInFiles);

  const handleOpenFile = useCallback(
    (entry: LsEntry) => {
      const absolutePath = joinListingEntryPath(listingDirectory, entry.name);
      const isLocal = sessionType === "local";
      openFilePreview({
        connectionId: isLocal ? LOCAL_CONNECTION_ID : resourceId ?? "",
        absolutePath,
        name: entry.name,
        resourceId: isLocal ? null : resourceId ?? null,
        sessionType,
      });
    },
    [listingDirectory, sessionType, resourceId, openFilePreview],
  );

  const ctxLabels = useMemo((): FileEntryCtxLabels => ({
    open: t("files.entryCtx.open"),
    openDir: t("files.entryCtx.openDir"),
    openFile: t("files.entryCtx.openFile"),
    edit: t("files.entryCtx.edit"),
    download: t("files.entryCtx.download"),
    copyName: t("files.entryCtx.copyName"),
    copyPath: t("files.entryCtx.copyPath"),
    copyCd: t("files.entryCtx.copyCd"),
    listDir: t("files.entryCtx.listDir"),
    viewContent: t("files.entryCtx.viewContent"),
    showInfo: t("files.entryCtx.showInfo"),
    revealInSftp: t("files.entryCtx.revealInSftp"),
    rename: t("files.entryCtx.rename"),
    chmod: t("files.entryCtx.chmod"),
    delete: t("files.entryCtx.delete"),
  }), [t]);

  const buildContextMenuItems = useCallback(
    ({ entry, absolutePath }: { entry: LsEntry; absolutePath: string }) => {
      const isDir = isLsEntryNavigable(entry);
      const isLocal = sessionType === "local";
      const canRevealSftp = !isLocal && Boolean(resourceId);

      return buildFileEntryContextMenuItems({
        isDir,
        labels: {
          ...ctxLabels,
          revealInSftp: isLocal
            ? t("files.entryCtx.revealInFiles")
            : ctxLabels.revealInSftp,
        },
        handlers: {
          onOpen: () => {
            if (isDir) onRunCommand?.(terminalCdCommand(absolutePath));
            else handleOpenFile(entry);
          },
          onEdit: isDir
            ? undefined
            : () => handleOpenFile(entry),
          onCopyName: () => void copyText(entry.name),
          onCopyPath: () => void copyText(absolutePath),
          onCopyCd: isDir
            ? () => void copyText(terminalCdCommand(absolutePath))
            : undefined,
          onListDir: isDir
            ? () => onRunCommand?.(shellListDirCommand(absolutePath))
            : undefined,
          onViewContent: isDir
            ? undefined
            : () => onRunCommand?.(shellViewFileCommand(absolutePath)),
          onShowInfo: () => onRunCommand?.(shellStatCommand(absolutePath)),
          onRevealInSftp: canRevealSftp
            ? () => {
                const dir = directoryForReveal(absolutePath, isDir);
                revealInSftp(resourceId!, dir);
              }
            : isLocal
              ? () => {
                  const dir = directoryForReveal(absolutePath, isDir);
                  revealInFiles(dir);
                }
              : undefined,
        },
      });
    },
    [
      ctxLabels,
      handleOpenFile,
      onRunCommand,
      resourceId,
      revealInFiles,
      revealInSftp,
      sessionType,
      t,
    ],
  );

  if (ready && resolved) {
    lastResolvedRef.current = resolved;
  }

  const displayListing = resolved ?? lastResolvedRef.current ?? listing;
  if (displayListing) {
    if (ready && resolved) {
      lastResolvedRef.current = resolved;
    }
    return (
      <LsListingView
        listing={displayListing}
        listingDirectory={listingDirectory}
        onRunCommand={onRunCommand}
        onOpenFile={handleOpenFile}
        buildContextMenuItems={buildContextMenuItems}
        highlightQuery={highlightQuery}
      />
    );
  }

  return (
    <pre className={`term-warp-output${isError ? " term-warp-output--error" : ""}`}>
      <FeedSearchHighlightText text={fallbackOutput} query={highlightQuery} />
    </pre>
  );
}

export const EnrichedLsListingView = memo(EnrichedLsListingViewInner);
