import { useCallback, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Button, TextInput } from "../../../components/ui";
import { useI18n } from "../../../i18n";
import {
  commands,
  type DockerImageProgress,
  type DockerImageSearchResult,
} from "../../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../../ipc/result";
import { showToast } from "../../../stores/toastStore";
import { buildDockerImageHomepageUrl } from "../dockerImageHomepageUrl";
import { DownloadIcon, ImageLayersIcon, PlayIcon, StarIcon } from "../icons";
import { DockerImageLogDialog } from "./DockerImageLogDialog";
import { DockerImageRunCommandDialog } from "./DockerImageRunCommandDialog";

export interface DockerImageSearchViewProps {
  connectionId: string;
  onBack: () => void;
  onImagesChanged: () => void;
}

const SEARCH_TIMEOUT_MS = 35_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} 超时 (${ms}ms)`));
    }, ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function formatCompactCount(value: number | null | undefined): string {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  if (n < 1_000_000_000) {
    const m = n / 1_000_000;
    return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  const b = n / 1_000_000_000;
  return `${b >= 100 ? Math.round(b) : b.toFixed(1).replace(/\.0$/, "")}B`;
}

function formatProgressLine(p: DockerImageProgress): string {
  const parts = [p.status];
  if (p.detail) parts.push(p.detail);
  if (p.progress != null && Number.isFinite(p.progress)) {
    parts.push(`${Math.round(p.progress * 100)}%`);
  }
  if (p.id) parts.push(`[${p.id}]`);
  return parts.filter(Boolean).join(" ");
}

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/** 镜像 Tab 内嵌搜索页：左结果 / 右主页预览。 */
export function DockerImageSearchView({
  connectionId,
  onBack,
  onImagesChanged,
}: DockerImageSearchViewProps) {
  const { t } = useI18n();
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<DockerImageSearchResult[]>([]);
  const [sourceMirror, setSourceMirror] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const [pullBusy, setPullBusy] = useState(false);
  const [pullLogOpen, setPullLogOpen] = useState(false);
  const [pullLog, setPullLog] = useState("");
  const [pullLogTitle, setPullLogTitle] = useState("");
  const [pullStatus, setPullStatus] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);

  const [runImage, setRunImage] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runLogOpen, setRunLogOpen] = useState(false);
  const [runLog, setRunLog] = useState("");
  const [runLogTitle, setRunLogTitle] = useState("");
  const [runStatus, setRunStatus] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);

  const selectedItem = useMemo(
    () => results.find((item) => item.name === selectedName) ?? null,
    [results, selectedName],
  );

  const homepageUrl = useMemo(() => {
    if (!selectedItem) return null;
    return buildDockerImageHomepageUrl(
      sourceMirror,
      selectedItem.name,
      Boolean(selectedItem.isOfficial),
    );
  }, [selectedItem, sourceMirror]);

  const handleSearch = useCallback(() => {
    const query = term.trim();
    if (!query || searching) return;
    void (async () => {
      setSearching(true);
      setError(null);
      setSearched(true);
      setResults([]);
      setSourceMirror(null);
      setSelectedName(null);
      try {
        const page = await withTimeout(
          unwrapCommand(commands.dockerSearchImages(connectionId, query, 50)),
          SEARCH_TIMEOUT_MS,
          "dockerSearchImages",
        );
        setResults(page.results);
        setSourceMirror(page.sourceMirror ?? null);
        if (page.results.length === 0) {
          setError(t("docker.imagesPanel.pullNoResults"));
        } else {
          setSelectedName(page.results[0]?.name ?? null);
        }
      } catch (err) {
        setResults([]);
        setSourceMirror(null);
        setSelectedName(null);
        setError(err instanceof Error ? err.message : formatIpcError(String(err)));
      } finally {
        setSearching(false);
      }
    })();
  }, [connectionId, searching, t, term]);

  const handlePull = useCallback(
    (image: string) => {
      const ref = image.trim();
      if (!ref || pullBusy) return;
      void (async () => {
        setPullBusy(true);
        setPullLogOpen(true);
        setPullLogTitle(t("docker.imagesPanel.pullLogTitle", { image: ref }));
        setPullLog(`${t("docker.imagesPanel.pullLogStart", { image: ref })}\n`);
        setPullStatus({ kind: "info", message: t("docker.imagesPanel.pulling") });

        const channel = `docker-pull-${Date.now()}`;
        let unlisten: (() => void) | undefined;
        try {
          unlisten = await listen<DockerImageProgress>(channel, (event) => {
            const line = formatProgressLine(event.payload);
            if (!line.trim()) return;
            setPullLog((prev) => `${prev}${line}\n`);
          });
          await unwrapCommand(commands.dockerPullImage(connectionId, ref, channel));
          setPullLog((prev) => `${prev}${t("docker.imagesPanel.pullLogDone")}\n`);
          setPullStatus({ kind: "success", message: t("docker.imagesPanel.pullSuccess", { image: ref }) });
          showToast(t("docker.imagesPanel.pullSuccess", { image: ref }));
          onImagesChanged();
        } catch (err) {
          const detail = err instanceof Error ? err.message : formatIpcError(String(err));
          setPullLog((prev) => `${prev}${detail}\n`);
          setPullStatus({ kind: "error", message: detail });
        } finally {
          unlisten?.();
          setPullBusy(false);
        }
      })();
    },
    [connectionId, onImagesChanged, pullBusy, t],
  );

  const handleRunConfirm = useCallback(
    (command: string) => {
      if (runBusy) return;
      void (async () => {
        setRunImage(null);
        setRunBusy(true);
        setRunLogOpen(true);
        setRunLogTitle(t("docker.imagesPanel.runLogTitle"));
        setRunLog(`$ ${command}\n\n`);
        setRunStatus({ kind: "info", message: t("docker.imagesPanel.running") });
        try {
          const result = await unwrapCommand(commands.dockerHostRunCli(connectionId, command));
          const chunks: string[] = [];
          if (result.stdout?.trim()) chunks.push(result.stdout.trimEnd());
          if (result.stderr?.trim()) chunks.push(result.stderr.trimEnd());
          chunks.push(`\n[exit ${result.exitCode}]`);
          setRunLog((prev) => `${prev}${chunks.join("\n")}\n`);
          if (result.exitCode === 0) {
            setRunStatus({ kind: "success", message: t("docker.imagesPanel.runSuccess") });
            showToast(t("docker.imagesPanel.runSuccess"));
            onImagesChanged();
          } else {
            setRunStatus({
              kind: "error",
              message: t("docker.imagesPanel.runFailed", { code: result.exitCode }),
            });
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : formatIpcError(String(err));
          setRunLog((prev) => `${prev}${detail}\n`);
          setRunStatus({ kind: "error", message: detail });
        } finally {
          setRunBusy(false);
        }
      })();
    },
    [connectionId, onImagesChanged, runBusy, t],
  );

  const handleOpenExternal = useCallback(() => {
    if (!homepageUrl) return;
    void openExternal(homepageUrl).catch(() => {
      window.open(homepageUrl, "_blank", "noopener,noreferrer");
    });
  }, [homepageUrl]);

  return (
    <div className="docker-image-search-view">
      <div className="docker-image-search-view__toolbar">
        <Button
          type="button"
          variant="icon"
          size="icon-sm"
          title={t("docker.imagesPanel.searchBack")}
          aria-label={t("docker.imagesPanel.searchBack")}
          onClick={onBack}
        >
          <BackIcon />
        </Button>
        <TextInput
          value={term}
          onChange={setTerm}
          placeholder={t("docker.imagesPanel.pullSearchPlaceholder")}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleSearch();
            }
          }}
          disabled={searching || pullBusy || runBusy}
          clearable
          copyable={false}
          spellCheck={false}
          autoComplete="off"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={searching || pullBusy || runBusy || !term.trim()}
          onClick={handleSearch}
        >
          {searching ? t("common.loading") : t("docker.imagesPanel.pullSearch")}
        </Button>
      </div>

      {error && !searching ? (
        <div className="docker-image-search-view__error">{error}</div>
      ) : null}

      <div className="docker-image-search-view__split">
        <div
          className="docker-image-search-view__results"
          aria-busy={searching}
          aria-live="polite"
        >
          {searching ? (
            <div className="docker-image-search-view__loading">
              <span className="docker-image-search-view__spinner" aria-hidden />
              <span>{t("docker.imagesPanel.pullSearching")}</span>
            </div>
          ) : !searched && results.length === 0 ? (
            <div className="docker-image-search-view__empty">
              {t("docker.imagesPanel.pullResultsHint")}
            </div>
          ) : results.length === 0 ? (
            <div className="docker-image-search-view__empty">
              {t("docker.imagesPanel.pullNoResults")}
            </div>
          ) : (
            results.map((item) => {
              const stars = item.starCount ?? 0;
              const pulls = item.pullCount ?? 0;
              const selected = item.name === selectedName;
              return (
                <div
                  key={item.name}
                  className={`docker-image-search-view__item${
                    selected ? " docker-image-search-view__item--selected" : ""
                  }`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  onClick={() => setSelectedName(item.name)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedName(item.name);
                    }
                  }}
                >
                  <div
                    className={`docker-image-search-view__icon${
                      item.isOfficial ? " docker-image-search-view__icon--official" : ""
                    }`}
                    aria-hidden
                  >
                    <ImageLayersIcon size={18} />
                  </div>
                  <div className="docker-image-search-view__item-main">
                    <span className="docker-image-search-view__name" title={item.name}>
                      {item.name}
                      {item.isOfficial ? (
                        <span className="badge badge-muted docker-image-search-view__badge">
                          {t("docker.imagesPanel.pullOfficial")}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className="docker-image-search-view__desc"
                      title={item.description || undefined}
                    >
                      {item.description || "—"}
                    </span>
                    <div className="docker-image-search-view__meta">
                      <span
                        className="docker-image-search-view__stat"
                        title={t("docker.imagesPanel.pullStars", { count: stars })}
                      >
                        <StarIcon size={12} />
                        {formatCompactCount(stars)}
                      </span>
                      {pulls > 0 ? (
                        <span
                          className="docker-image-search-view__stat"
                          title={t("docker.imagesPanel.pullPulls", { count: pulls })}
                        >
                          <DownloadIcon size={12} />
                          {formatCompactCount(pulls)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div
                    className="docker-image-search-view__actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Button
                      type="button"
                      variant="icon"
                      size="icon-xs"
                      title={t("docker.imagesPanel.pullAction")}
                      aria-label={t("docker.imagesPanel.pullAction")}
                      disabled={pullBusy || runBusy}
                      onClick={() => handlePull(item.name)}
                    >
                      <DownloadIcon size={14} />
                    </Button>
                    <Button
                      type="button"
                      variant="icon"
                      size="icon-xs"
                      title={t("docker.imagesPanel.runAction")}
                      aria-label={t("docker.imagesPanel.runAction")}
                      disabled={pullBusy || runBusy}
                      onClick={() => setRunImage(item.name)}
                    >
                      <PlayIcon />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <aside className="docker-image-search-view__preview">
          {!selectedItem || !homepageUrl ? (
            <div className="docker-image-search-view__preview-empty">
              {t("docker.imagesPanel.pullHomepageEmpty")}
            </div>
          ) : (
            <>
              <div className="docker-image-search-view__preview-bar">
                <span className="docker-image-search-view__preview-url" title={homepageUrl}>
                  {homepageUrl}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleOpenExternal}
                  title={t("docker.imagesPanel.pullHomepageOpen")}
                >
                  {t("docker.imagesPanel.pullHomepageOpen")}
                </Button>
              </div>
              <iframe
                key={homepageUrl}
                className="docker-image-search-view__preview-frame"
                src={homepageUrl}
                title={t("docker.imagesPanel.pullHomepageTitle", { name: selectedItem.name })}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                referrerPolicy="no-referrer"
              />
            </>
          )}
        </aside>
      </div>

      <DockerImageLogDialog
        open={pullLogOpen}
        title={pullLogTitle}
        log={pullLog}
        busy={pullBusy}
        status={pullStatus}
        onClose={() => {
          if (!pullBusy) setPullLogOpen(false);
        }}
      />

      <DockerImageRunCommandDialog
        open={Boolean(runImage)}
        imageName={runImage ?? ""}
        busy={runBusy}
        onClose={() => {
          if (!runBusy) setRunImage(null);
        }}
        onConfirm={handleRunConfirm}
      />

      <DockerImageLogDialog
        open={runLogOpen}
        title={runLogTitle}
        log={runLog}
        busy={runBusy}
        status={runStatus}
        onClose={() => {
          if (!runBusy) setRunLogOpen(false);
        }}
      />
    </div>
  );
}
