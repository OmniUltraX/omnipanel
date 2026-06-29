export type DebugStatus = {
  mode?: string;
  configured: boolean;
  model: string | null;
  baseUrl: string | null;
  apiStandard: string | null;
  mcpCount: number;
  skillsDirs: string[];
  sessionReady: boolean;
  cwd: string;
};

export type DebugStreamEvent =
  | { type: "content_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_call_update"; id: string; status: "completed" | "failed"; result?: string }
  | { type: "done" }
  | { type: "error"; message: string };

export async function fetchDebugStatus(): Promise<DebugStatus> {
  const res = await fetch("/api/status");
  if (!res.ok) {
    throw new Error(`status ${res.status}`);
  }
  return (await res.json()) as DebugStatus;
}

export async function resetDebugSession(): Promise<void> {
  const res = await fetch("/api/session/reset", { method: "POST" });
  if (!res.ok) {
    throw new Error(`reset failed: ${res.status}`);
  }
}

export async function cancelDebugPrompt(): Promise<void> {
  await fetch("/api/cancel", { method: "POST" }).catch(() => {});
}

export async function runDebugPrompt(
  text: string,
  onEvent: (event: DebugStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `prompt failed: ${res.status}`);
  }

  if (!res.body) {
    throw new Error("响应体为空");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      let eventType = "message";
      let dataLine = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          dataLine = line.slice(6);
        }
      }
      if (!dataLine) continue;

      try {
        const parsed = JSON.parse(dataLine) as DebugStreamEvent;
        if (parsed.type === eventType || parsed.type) {
          onEvent(parsed);
        }
      } catch {
        /* skip malformed block */
      }
    }
  }
}
