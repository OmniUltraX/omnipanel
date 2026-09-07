export default {
    title: "Team sync key required",
    hint: "This device has no team sync key yet and cannot decrypt cloud module or conversation snapshots.",
    forcedHint:
      "You switched to a new team, but this device does not have its sync key yet. Import a key file from a teammate, or wait for an online device to relay it.",
    forcedImportRequired:
      "Could not obtain the key from an online device. Import a key file to continue.",
    requesting: "Requesting sync key from online devices in this team…",
    waiting: "Waiting for another online device in this team to relay the key…",
    importHint:
      "If no peer in this team is online, import a key from another member, or create a new key after confirming (you will not be able to decrypt existing cloud snapshots encrypted with the previous key).",
    importBtn: "Import key file",
    createBtn: "Create new key",
    createConfirmTitle: "Create a new sync key?",
    createConfirm:
      "This generates a sync key for the current team on this device. If the team already has cloud snapshots encrypted with another key, you will not be able to decrypt them. Use only on the first device or when you are sure old data is not needed.",
    createDone: "Sync key created, fingerprint {fingerprint}",
    retryRelay: "Retry request",
    later: "Later",
    noTeam: "Sign in and select a sync team first",
    timeout: "Timed out waiting for a relay. Import a key file or try again later.",
    keyReceived: "Sync key received, fingerprint {fingerprint}",
    importDone: "Sync key imported, fingerprint {fingerprint}",
    successWithData: "Sync key ready. Pulled {connections} connections and {databases} databases.",
    successNoCloudData: "Sync key ready, but the cloud has no module snapshot yet.",
    pullFailed: "Key is ready, but cloud pull failed. Use Pull now in Settings later.",
  } as const;
