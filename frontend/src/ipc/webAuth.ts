/** Same-origin browser sessions. The server API key is never persisted in browser storage. */
const base = import.meta.env.VITE_OMNIPANEL_API_BASE ?? "";
export async function webAuthStatus(): Promise<{ required: boolean; authenticated: boolean }> {
  const response = await fetch(`${base}/ipc/auth`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`Authentication service unavailable (${response.status})`);
  return response.json();
}
export async function webLogin(apiKey: string): Promise<void> {
  const response = await fetch(`${base}/ipc/auth`, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: apiKey }),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "API Key 不正确 / Invalid API key" : `Authentication failed (${response.status})`);
}
export async function webLogout(): Promise<void> {
  const response = await fetch(`${base}/ipc/auth`, { method: "DELETE", credentials: "same-origin" });
  if (!response.ok) throw new Error(`Logout failed (${response.status})`);
  window.location.reload();
}
