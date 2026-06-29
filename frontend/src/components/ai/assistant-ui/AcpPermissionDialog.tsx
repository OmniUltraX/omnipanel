import { useCallback, useState } from "react";
import { Button } from "../../ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import type { AcpStreamEvent } from "../../../lib/acp/acpStream";
import { respondAcpPermission } from "../../../lib/acp/acpStream";

type PermissionEvent = Extract<AcpStreamEvent, { type: "permission_request" }>;

interface AcpPermissionDialogProps {
  request: PermissionEvent | null;
  onClose: () => void;
}

export function AcpPermissionDialog({ request, onClose }: AcpPermissionDialogProps) {
  const [busy, setBusy] = useState(false);

  const handleChoice = useCallback(
    async (optionId: string) => {
      if (!request) return;
      setBusy(true);
      try {
        await respondAcpPermission(request.requestId ?? 0, optionId);
        onClose();
      } catch (error) {
        console.error("[ACP] 权限响应失败:", error);
      } finally {
        setBusy(false);
      }
    },
    [request, onClose],
  );

  if (!request) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="acp-permission-dialog">
        <DialogHeader>
          <DialogTitle>工具执行确认</DialogTitle>
          <DialogDescription>
            Agent 请求执行工具：<strong>{request.title}</strong>
          </DialogDescription>
        </DialogHeader>
        {request.raw_input ? (
          <pre className="acp-permission-input">{request.raw_input}</pre>
        ) : null}
        <DialogFooter className="acp-permission-actions">
          {request.options.map((option) => (
            <Button
              key={option.optionId}
              variant={option.optionId.includes("reject") ? "secondary" : "primary"}
              disabled={busy}
              onClick={() => void handleChoice(option.optionId)}
            >
              {option.name}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
