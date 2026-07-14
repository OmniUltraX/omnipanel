import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { FormDialog } from "../../components/ui/form/FormDialog";
import { TextInput } from "../../components/ui/form/TextInput";
import { useI18n } from "../../i18n";
import { commands, type DockerImageSearchResult } from "../../ipc/bindings";
import { showToast } from "../../stores/toastStore";

export interface DockerImagePullDialogProps {
  open: boolean;
  connectionId: string;
  onClose: () => void;
  onPulled: () => void;
}

export function DockerImagePullDialog({
  open,
  connectionId,
  onClose,
  onPulled,
}: DockerImagePullDialogProps) {
  const { t } = useI18n();
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<DockerImageSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualImage, setManualImage] = useState("");

  useEffect(() => {
    if (!open) {
      setTerm("");
      setResults([]);
      setSearching(false);
      setPulling(null);
      setError(null);
      setManualImage("");
    }
  }, [open]);

  const handleSearch = useCallback(() => {
    const query = term.trim();
    if (!query) return;
    void (async () => {
      setSearching(true);
      setError(null);
      try {
        const res = await commands.dockerSearchImages(connectionId, query, 25);
        if (res.status !== "ok") throw new Error(res.error.message);
        setResults(res.data);
        if (res.data.length === 0) {
          setError(t("docker.imagesPanel.pullNoResults"));
        }
      } catch (err) {
        setResults([]);
        setError(String(err));
      } finally {
        setSearching(false);
      }
    })();
  }, [connectionId, t, term]);

  const handlePull = useCallback(
    (image: string) => {
      const ref = image.trim();
      if (!ref || pulling) return;
      void (async () => {
        setPulling(ref);
        setError(null);
        try {
          const channel = `docker-pull-${Date.now()}`;
          const res = await commands.dockerPullImage(connectionId, ref, channel);
          if (res.status !== "ok") throw new Error(res.error.message);
          showToast(t("docker.imagesPanel.pullSuccess", { image: ref }));
          onPulled();
          onClose();
        } catch (err) {
          setError(String(err));
        } finally {
          setPulling(null);
        }
      })();
    },
    [connectionId, onClose, onPulled, pulling, t],
  );

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("docker.imagesPanel.pullTitle")}
      subtitle={t("docker.imagesPanel.pullSubtitle")}
      size="lg"
      clipboardAssist={false}
      cancelDisabled={Boolean(pulling)}
      closeDisabled={Boolean(pulling)}
      primaryAction={{
        label: pulling ? t("docker.imagesPanel.pulling") : t("docker.imagesPanel.pullManual"),
        disabled: Boolean(pulling) || !manualImage.trim(),
        onClick: () => handlePull(manualImage),
      }}
      status={error ? { kind: "error", message: error } : null}
    >
      <div className="docker-image-pull-dialog">
        <div className="docker-image-pull-dialog__row">
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
            disabled={Boolean(pulling)}
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

        <div className="docker-image-pull-dialog__row">
          <TextInput
            value={manualImage}
            onChange={setManualImage}
            placeholder={t("docker.imagesPanel.pullManualPlaceholder")}
            disabled={Boolean(pulling)}
          />
        </div>

        <div className="docker-image-pull-dialog__results">
          {results.length === 0 ? (
            <div className="docker-image-pull-dialog__empty">
              {t("docker.imagesPanel.pullResultsHint")}
            </div>
          ) : (
            results.map((item) => (
              <div key={item.name} className="docker-image-pull-dialog__item">
                <div className="docker-image-pull-dialog__item-main">
                  <span className="docker-image-pull-dialog__name" title={item.name}>
                    {item.name}
                    {item.isOfficial ? (
                      <span className="badge badge-muted docker-image-pull-dialog__badge">
                        {t("docker.imagesPanel.pullOfficial")}
                      </span>
                    ) : null}
                  </span>
                  <span className="docker-image-pull-dialog__desc" title={item.description}>
                    {item.description || "—"}
                  </span>
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
            ))
          )}
        </div>
      </div>
    </FormDialog>
  );
}
