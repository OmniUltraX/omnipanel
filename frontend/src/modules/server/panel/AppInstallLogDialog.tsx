import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import { LogViewer } from "@/components/ui/content/LogViewer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/primitives/dialog";
import { createOnePanelClient } from "@/lib/onepanel";
import type { ServerEntry } from "./serverConnection";

interface AppInstallLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: ServerEntry;
  installId: number | null;
  appLabel: string;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function AppInstallLogDialog({
  open,
  onOpenChange,
  server,
  installId,
  appLabel,
}: AppInstallLogDialogProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const fetchLog = useCallback(async () => {
    if (!open || installId == null) return;
    setLoading(true);
    try {
      const client = createOnePanelClient(server.address, server.key, server.id);
      const result = await client.readAppInstallTaskLog({
        installId,
        page: 1,
        pageSize: 500,
        latest: true,
      });
      setText(result.content);
      setEnded(Boolean(result.end));
      setError(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [installId, open, server.address, server.id, server.key]);

  useEffect(() => {
    if (!open) {
      setText("");
      setError(null);
      setEnded(false);
      setLoading(false);
      return;
    }
    if (installId == null) return;
    void fetchLog();
    if (ended) return;
    const timer = window.setInterval(() => {
      void fetchLog();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [ended, fetchLog, installId, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="app-install-log-dialog sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("server.appMarket.installLogTitle", { name: appLabel })}
          </DialogTitle>
        </DialogHeader>
        <LogViewer
          text={text}
          loading={loading && !text}
          loadingText={t("server.appMarket.installLogLoading")}
          emptyText={t("server.appMarket.installLogEmpty")}
          error={error}
          streaming
          autoScroll
          className="app-install-log-dialog__viewer"
        />
      </DialogContent>
    </Dialog>
  );
}
