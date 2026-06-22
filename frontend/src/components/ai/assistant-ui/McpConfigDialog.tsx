"use client";

import { useCallback, useEffect, useState, type FC, type ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useI18n } from "../../../i18n";
import { commands } from "../../../ipc/bindings";
import type { McpServiceView } from "../../../ipc/bindings";

export interface McpConfigDialogProps {
  children?: ReactNode;
}

const STATUS_MAP: Record<string, "connected" | "connecting" | "error" | "disconnected"> = {
  running: "connected",
  starting: "connecting",
  error: "error",
  stopped: "disconnected",
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  running: "default",
  starting: "secondary",
  error: "destructive",
  stopped: "secondary",
};

export const McpConfigDialog: FC<McpConfigDialogProps> = ({ children }) => {
  const { t } = useI18n();
  const [services, setServices] = useState<McpServiceView[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const loadServices = useCallback(async () => {
    setLoading(true);
    try {
      const result = await commands.mcpListServices();
      if (result.status === "ok") {
        setServices(result.data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadServices();
  }, [open, loadServices]);

  const handleToggle = useCallback(
    async (service: McpServiceView) => {
      try {
        const target = service.status !== "running";
        const result = await commands.mcpSetServiceRunning(service.id, target);
        if (result.status === "ok") {
          setServices((prev) =>
            prev.map((s) => (s.id === service.id ? result.data : s)),
          );
        }
      } catch {
        // ignore
      }
    },
    [],
  );

  const statusLabel = (s: McpServiceView): string => {
    switch (s.status) {
      case "running":
        return "Running";
      case "starting":
        return "Starting...";
      case "stopped":
        return "Stopped";
      case "error":
        return "Error";
      default:
        return s.status;
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children ?? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
          >
            <PlugIcon />
            MCP
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>MCP Services</DialogTitle>
          <DialogDescription>
            View and manage Model Context Protocol services.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {loading ? (
            <div className="text-muted-foreground flex items-center justify-center py-8 text-sm">
              Loading...
            </div>
          ) : services.length === 0 ? (
            <div className="text-muted-foreground flex items-center justify-center py-8 text-sm">
              No MCP services configured.
            </div>
          ) : (
            services.map((service) => (
              <div
                key={service.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg border p-3",
                  service.status === "error" && "border-destructive/40",
                )}
              >
                <div className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md border">
                  <ServerIcon size={16} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{service.name}</span>
                  <span className="text-muted-foreground text-xs">{statusLabel(service)}</span>
                </div>
                {service.errorMessage && (
                  <span className="text-destructive max-w-[120px] truncate text-xs" title={service.errorMessage}>
                    {service.errorMessage}
                  </span>
                )}
                <Button
                  variant={service.status === "running" ? "outline" : "default"}
                  size="xs"
                  onClick={() => handleToggle(service)}
                >
                  {service.status === "running" ? "Stop" : "Start"}
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

function PlugIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a6 6 0 0 1-12 0V8Z" />
    </svg>
  );
}

function ServerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
      <line x1="6" x2="6.01" y1="6" y2="6" />
      <line x1="6" x2="6.01" y1="18" y2="18" />
    </svg>
  );
}
