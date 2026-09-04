export default {
    title: "Device authentication required",
    hint: "This device is not sync-authenticated yet. Scan with the WeChat mini program signed into the same account, then confirm the verification code.",
    qrAlt: "Device auth QR code",
    verificationCode: "Code",
    expire: "Time left {time}",
    expired: "QR expired — refresh to try again",
    waiting: "Waiting for mini program confirmation and key transfer…",
    loading: "Generating auth QR…",
    needRefresh: "Tap refresh to get a new QR code",
    refresh: "Refresh QR",
    later: "Later",
    success: "Device authenticated — credentials will sync automatically",
    successWithData:
      "Device authenticated — synced {connections} connections, {databases} databases",
    successNoCloudData:
      "Device authenticated, but no cloud module snapshot yet. Open OmniPanel on a device that still has data to republish, then tap Pull Now here.",
    pullFailed: "Authenticated, but cloud pull failed. Retry with Pull Now in Settings.",
    timeout: "Timed out — refresh the QR and try again",
  } as const;
