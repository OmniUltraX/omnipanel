declare module "standardwebhooks-cjs" {
  export class WebhookVerificationError extends Error {
    constructor(message: string);
  }

  export class Webhook {
    constructor(secret: string | Uint8Array, options?: { format?: "raw" | "base64" });
    sign(msgId: string, timestamp: Date, payload: string | Buffer): string;
    verify(payload: string, headers: Record<string, string>): unknown;
  }

  const mod: {
    Webhook: typeof Webhook;
    WebhookVerificationError: typeof WebhookVerificationError;
  };

  export default mod;
}
