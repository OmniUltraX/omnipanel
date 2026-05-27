import { useEffect, useRef } from "react";
import type { Terminal, IMarker } from "@xterm/xterm";
import { useBlocksStore, createBlockId } from "../stores/blocksStore";

interface PendingBlock {
  startLine: number;
  command: string;
  cwd: string;
}

export function useShellIntegration(
  terminal: Terminal | null,
  sessionId: string
) {
  const pendingRef = useRef<PendingBlock | null>(null);
  const currentCwdRef = useRef<string>("");

  useEffect(() => {
    if (!terminal) return;

    const addBlock = useBlocksStore.getState().addBlock;
    const updateBlock = useBlocksStore.getState().updateBlock;

    const disposables: { dispose(): void }[] = [];

    // Register OSC 133 handler (shell integration protocol)
    disposables.push(
      terminal.parser.registerOscHandler(133, (data: string) => {
        const parts = data.split(";");
        const code = parts[0];

        switch (code) {
          case "A": {
            // Prompt start — mark where the command block begins
            const cursorY =
              terminal.buffer.active.cursorY +
              terminal.buffer.active.baseY;
            pendingRef.current = {
              startLine: cursorY,
              command: "",
              cwd: currentCwdRef.current,
            };
            break;
          }

          case "B": {
            // Prompt end — user has typed command, read it from buffer
            if (pendingRef.current) {
              const buf = terminal.buffer.active;
              const y = buf.cursorY + buf.baseY;
              // Read the command from the prompt line
              const line = buf.getLine(y);
              if (line) {
                let text = "";
                for (let i = 0; i < line.length; i++) {
                  text += line.getCell(i)?.getChars() || "";
                }
                // Strip ANSI and trim
                text = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
                pendingRef.current.command = text;
              }
            }
            break;
          }

          case "C": {
            // Command output start — create the block
            if (pendingRef.current) {
              const marker = terminal.markers.add(
                terminal.buffer.active.cursorY + terminal.buffer.active.baseY
              );
              const blockId = createBlockId();
              addBlock(sessionId, {
                id: blockId,
                sessionId,
                command: pendingRef.current.command,
                output: "",
                exitCode: null,
                startLine: pendingRef.current.startLine,
                endLine: -1,
                marker,
                cwd: pendingRef.current.cwd,
                timestamp: Date.now(),
                status: "running",
              });
              // Store blockId for matching with D
              pendingRef.current = {
                ...pendingRef.current,
                startLine: marker.line,
              } as PendingBlock & { blockId: string };
              (pendingRef.current as any).blockId = blockId;
            }
            break;
          }

          case "D": {
            // Command end — finalize block with exit code
            const exitCode = parseInt(parts[1] || "0", 10);
            const pb = pendingRef.current as any;
            if (pb?.blockId) {
              const endLine =
                terminal.buffer.active.cursorY +
                terminal.buffer.active.baseY;
              updateBlock(pb.blockId, {
                exitCode,
                endLine,
                status: exitCode === 0 ? "completed" : "failed",
              });
            }
            pendingRef.current = null;
            break;
          }
        }

        return true; // handled
      })
    );

    // Register OSC 1337 handler (iTerm2 extensions — current directory)
    disposables.push(
      terminal.parser.registerOscHandler(1337, (data: string) => {
        if (data.startsWith("CurrentDir=")) {
          currentCwdRef.current = data.substring("CurrentDir=".length);
        }
        return true;
      })
    );

    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [terminal, sessionId]);
}
