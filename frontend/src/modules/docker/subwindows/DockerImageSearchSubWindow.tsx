import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { TextInput } from "../../../components/ui/form/TextInput";
import { SubWindow } from "../../../components/ui/window";
import { useI18n } from "../../../i18n";
import { commands, type DockerImageSearchResult } from "../../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../../ipc/result";
import { showToast } from "../../../stores/toastStore";
import { DownloadIcon, ImageLayersIcon, StarIcon } from "../icons";

export interface DockerImageSearchSubWindowProps {
  open: boolean;
  connectionId: string;
  onClose: () => void;
  onPulled: () => void;
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

/** 紧凑数字：1234 → 1.2K，1_500_000 → 1.5M */
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

export function DockerImageSearchSubWindow({
  open,
  connectionId,
  onClose,
  onPulled,
}: DockerImageSearchSubWindowProps) {
  const { t } = useI18n();
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<DockerImageSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (!open) {
      setTerm("");
      setResults([]);
      setSearching(false);
      setPulling(null);
      setError(null);
      setSearched(false);
    }
  }, [open]);

  const handleSearch = useCallback(() => {
    const query = term.trim();
    if (!query || searching) return;
    void (async () => {
      setSearching(true);
      setError(null);
      setSearched(true);
      setResults([]);
      try {
        const data = await withTimeout(
          unwrapCommand(commands.dockerSearchImages(connectionId, query, 50)),
          SEARCH_TIMEOUT_MS,
          "dockerSearchImages",
        );
        setResults(data);
        if (data.length === 0) {
          setError(t("docker.imagesPanel.pullNoResults"));
        }
      } catch (err) {
        setResults([]);
        setError(err instanceof Error ? err.message : formatIpcError(String(err)));
      } finally {
        setSearching(false);
      }
    })();
  }, [connectionId, searching, t, term]);

  const handlePull = useCallback(
    (image: string) => {
      const ref = image.trim();
      if (!ref || pulling) return;
      void (async () => {
        setPulling(ref);
        setError(null);
        try {
          const channel = `docker-pull-${Date.now()}`;
          await unwrapCommand(commands.dockerPullImage(connectionId, ref, channel));
          showToast(t("docker.imagesPanel.pullSuccess", { image: ref }));
          onPulled();
          onClose();
        } catch (err) {
          setError(err instanceof Error ? err.message : formatIpcError(String(err)));
        } finally {
          setPulling(null);
        }
      })();
    },
    [connectionId, onClose, onPulled, pulling, t],
  );

  return (
    <SubWindow
      open={open}
      title={t("docker.imagesPanel.pullTitle")}
      onClose={onClose}
      widthRatio={0.55}
      heightRatio={0.68}
      className="docker-image-search-subwindow-shell"
    >
      <div className="docker-image-search-subwindow">
        <div className="docker-image-search-subwindow__toolbar">
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
            disabled={Boolean(pulling) || searching}
            clearable
            copyable={false}
            spellCheck={false}
            autoComplete="off"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={searching || Boolean(pulling) || !term.trim()}
            onClick={handleSearch}
          >
            {searching ? t("common.loading") : t("docker.imagesPanel.pullSearch")}
          </Button>
        </div>

        {error && !searching ? (
          <div className="docker-image-search-subwindow__error">{error}</div>
        ) : null}

        <div
          className="docker-image-search-subwindow__results"
          aria-busy={searching}
          aria-live="polite"
        >
          {searching ? (
            <div className="docker-image-search-subwindow__loading">
              <span className="docker-image-search-subwindow__spinner" aria-hidden />
              <span>{t("docker.imagesPanel.pullSearching")}</span>
            </div>
          ) : !searched && results.length === 0 ? (
            <div className="docker-image-search-subwindow__empty">
              {t("docker.imagesPanel.pullResultsHint")}
            </div>
          ) : results.length === 0 ? (
            <div className="docker-image-search-subwindow__empty">
              {t("docker.imagesPanel.pullNoResults")}
            </div>
          ) : (
            results.map((item) => {
              const stars = item.starCount ?? 0;
              const pulls = item.pullCount ?? 0;
              return (
                <div key={item.name} className="docker-image-search-subwindow__item">
                  <div
                    className={`docker-image-search-subwindow__icon${
                      item.isOfficial ? " docker-image-search-subwindow__icon--official" : ""
                    }`}
                    aria-hidden
                  >
                    <ImageLayersIcon size={18} />
                  </div>
                  <div className="docker-image-search-subwindow__item-main">
                    <span className="docker-image-search-subwindow__name" title={item.name}>
                      {item.name}
                      {item.isOfficial ? (
                        <span className="badge badge-muted docker-image-search-subwindow__badge">
                          {t("docker.imagesPanel.pullOfficial")}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className="docker-image-search-subwindow__desc"
                      title={item.description || undefined}
                    >
                      {item.description || "—"}
                    </span>
                    <div className="docker-image-search-subwindow__meta">
                      <span
                        className="docker-image-search-subwindow__stat"
                        title={t("docker.imagesPanel.pullStars", { count: stars })}
                      >
                        <StarIcon size={12} />
                        {formatCompactCount(stars)}
                      </span>
                      {pulls > 0 ? (
                        <span
                          className="docker-image-search-subwindow__stat"
                          title={t("docker.imagesPanel.pullPulls", { count: pulls })}
                        >
                          <DownloadIcon size={12} />
                          {formatCompactCount(pulls)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={Boolean(pulling)}
                    onClick={() => handlePull(item.name)}
                  >
                    {pulling === item.name
                      ? t("docker.imagesPanel.pulling")
                      : t("docker.imagesPanel.pullAction")}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </SubWindow>
  );
}
