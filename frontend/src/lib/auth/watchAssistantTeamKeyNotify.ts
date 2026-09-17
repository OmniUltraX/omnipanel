/**
 * 浏览器端订阅 /api/notify/wait（带 Authorization，EventSource 无法自定义头）。
 */
const AUTH_ASSET_BASE = "https://mp.99.protected.fun";

export const EVENT_ASSISTANT_TEAM_KEY_RECEIVED = "assistant.team_key.received";

export type TeamKeyReceivedPayload = {
  teamId: number;
  assistantDeviceId: string;
  assistantDeviceName: string;
  appId: string;
};

function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join("\n") };
}

function extractTeamKeyPayload(raw: unknown): TeamKeyReceivedPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const env = raw as Record<string, unknown>;
  const event = String(env.event ?? env.Event ?? "");
  if (event && event !== EVENT_ASSISTANT_TEAM_KEY_RECEIVED) return null;
  const payloadRaw = env.payload ?? env.Payload ?? env;
  let payload: Record<string, unknown> = {};
  if (typeof payloadRaw === "string") {
    try {
      payload = JSON.parse(payloadRaw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (payloadRaw && typeof payloadRaw === "object") {
    payload = payloadRaw as Record<string, unknown>;
  }
  const teamId = Number(payload.teamId ?? payload.team_id ?? 0);
  const assistantDeviceId = String(
    payload.assistantDeviceId ?? payload.assistant_device_id ?? "",
  ).trim();
  if (!Number.isFinite(teamId) || teamId <= 0 || !assistantDeviceId) return null;
  return {
    teamId,
    assistantDeviceId,
    assistantDeviceName: String(
      payload.assistantDeviceName ?? payload.assistant_device_name ?? "",
    ).trim(),
    appId: String(payload.appId ?? payload.app_id ?? "omni-assistant").trim(),
  };
}

/**
 * 订阅助手收妥组织密钥的通知；连接时会先推 latest 匹配事件。
 */
export async function watchAssistantTeamKeyReceived(opts: {
  token: string;
  deviceId: string;
  signal: AbortSignal;
  onEvent: (payload: TeamKeyReceivedPayload) => void;
}): Promise<void> {
  const { token, deviceId, signal, onEvent } = opts;
  if (!token || !deviceId) return;

  const url = `${AUTH_ASSET_BASE}/api/notify/wait?events=${encodeURIComponent(
    EVENT_ASSISTANT_TEAM_KEY_RECEIVED,
  )}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-App-Id": "omni-client",
      "X-Device-Id": deviceId,
      Accept: "text/event-stream",
    },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`notify wait failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\n\n|\r\n\r\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const parsed = parseSseBlock(part.trim());
      if (!parsed) continue;
      if (parsed.event !== "notify" && parsed.event !== "message") continue;
      try {
        const json = JSON.parse(parsed.data) as unknown;
        const payload = extractTeamKeyPayload(json);
        if (payload) onEvent(payload);
      } catch {
        /* ignore malformed */
      }
    }
  }
}
