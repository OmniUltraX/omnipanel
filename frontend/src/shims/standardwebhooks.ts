/**
 * standardwebhooks 为 CommonJS；通过独立 alias `standardwebhooks-cjs` 引入真实包，避免与对外 alias 循环。
 */
import mod from "standardwebhooks-cjs";

type WebhookModule = typeof import("standardwebhooks");

const resolved = (mod as WebhookModule & { default?: WebhookModule }).default ?? (mod as WebhookModule);

export const Webhook = resolved.Webhook;
export const WebhookVerificationError = resolved.WebhookVerificationError;

export default resolved;
