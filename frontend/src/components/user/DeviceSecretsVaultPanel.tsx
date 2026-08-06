import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import {
  DEVICE_CODE_LEN,
  isValidDeviceCode,
  normalizeDeviceCode,
  useDeviceSyncCodeStore,
} from "../../stores/deviceSyncCodeStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { showToast } from "../../stores/toastStore";
import { Button } from "../ui/Button";

/**
 * 设备识别码密文库同步。
 * 识别码即主密码；「同步」= 解锁 + 全量上传本机凭据密文到 OSS。
 */
export function DeviceSecretsVaultPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const ossPath = useUserProfileStore((s) => s.ossPath);
  const deviceCode = useDeviceSyncCodeStore((s) => s.deviceCode);
  const setDeviceCode = useDeviceSyncCodeStore((s) => s.setDeviceCode);

  const [digits, setDigits] = useState<string[]>(() => toDigits(deviceCode));
  const [busy, setBusy] = useState(false);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    setDigits(toDigits(deviceCode));
  }, [deviceCode]);

  const code = digits.join("");
  const codeReady = isValidDeviceCode(code);
  const canSync = Boolean(token && ossPath.trim() && codeReady && !busy);

  const applyDigits = useCallback(
    (next: string[]) => {
      const normalized = next.map((d) => normalizeDeviceCode(d).slice(0, 1));
      setDigits(normalized);
      const joined = normalized.join("");
      if (isValidDeviceCode(joined) && joined !== deviceCode) {
        setDeviceCode(joined);
        void unwrapCommand(commands.secretsVaultLock()).catch(() => undefined);
      }
    },
    [deviceCode, setDeviceCode],
  );

  const focusAt = (index: number) => {
    const el = inputsRef.current[Math.max(0, Math.min(DEVICE_CODE_LEN - 1, index))];
    el?.focus();
    el?.select();
  };

  const handleDigitChange = (index: number, raw: string) => {
    const cleaned = normalizeDeviceCode(raw);
    if (!cleaned) {
      const next = [...digits];
      next[index] = "";
      applyDigits(next);
      return;
    }
    // 支持在单格粘贴/连打多位
    if (cleaned.length > 1) {
      const next = [...digits];
      for (let i = 0; i < cleaned.length && index + i < DEVICE_CODE_LEN; i++) {
        next[index + i] = cleaned[i]!;
      }
      applyDigits(next);
      focusAt(index + cleaned.length);
      return;
    }
    const next = [...digits];
    next[index] = cleaned;
    applyDigits(next);
    if (index < DEVICE_CODE_LEN - 1) focusAt(index + 1);
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      if (digits[index]) {
        const next = [...digits];
        next[index] = "";
        applyDigits(next);
      } else if (index > 0) {
        focusAt(index - 1);
        const next = [...digits];
        next[index - 1] = "";
        applyDigits(next);
      }
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowLeft" && index > 0) {
      e.preventDefault();
      focusAt(index - 1);
    } else if (e.key === "ArrowRight" && index < DEVICE_CODE_LEN - 1) {
      e.preventDefault();
      focusAt(index + 1);
    }
  };

  const handlePaste = (index: number, e: ClipboardEvent<HTMLInputElement>) => {
    const text = normalizeDeviceCode(e.clipboardData.getData("text"));
    if (!text) return;
    e.preventDefault();
    const next = [...digits];
    for (let i = 0; i < text.length && index + i < DEVICE_CODE_LEN; i++) {
      next[index + i] = text[i]!;
    }
    applyDigits(next);
    focusAt(index + text.length);
  };

  const handleSync = async () => {
    if (!canSync) return;
    setBusy(true);
    try {
      await unwrapCommand(commands.secretsVaultUnlock(code));
      const result = await unwrapCommand(
        commands.secretsVaultPush({
          token: token!,
          deviceCode: code,
          ossPath: ossPath.trim(),
        }),
      );
      showToast(t("userCenter.devices.vault.syncSuccess", { n: result.secretCount }));
    } catch (error) {
      showToast(formatIpcError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="user-center-section user-center-vault">
      <h3 className="user-center-section__title">{t("userCenter.devices.vault.title")}</h3>

      <div className="user-center-vault__otp" role="group" aria-label={t("userCenter.devices.vault.codeLabel")}>
        {digits.map((digit, index) => (
          <input
            key={index}
            ref={(el) => {
              inputsRef.current[index] = el;
            }}
            className="user-center-vault__otp-cell"
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={DEVICE_CODE_LEN}
            value={digit}
            disabled={busy}
            aria-label={t("userCenter.devices.vault.codeDigit", { n: index + 1 })}
            onChange={(e) => handleDigitChange(index, e.target.value)}
            onKeyDown={(e) => handleKeyDown(index, e)}
            onPaste={(e) => handlePaste(index, e)}
            onFocus={(e) => e.currentTarget.select()}
          />
        ))}
      </div>

      <div className="user-center-vault__actions">
        <Button type="button" variant="secondary" size="sm" disabled={!canSync} onClick={() => void handleSync()}>
          {t("userCenter.devices.vault.sync")}
        </Button>
      </div>

      {!ossPath.trim() ? (
        <p className="user-center-section__desc user-center-vault__warn">
          {t("userCenter.devices.vault.needOssPath")}
        </p>
      ) : null}
    </section>
  );
}

function toDigits(code: string): string[] {
  const normalized = normalizeDeviceCode(code);
  return Array.from({ length: DEVICE_CODE_LEN }, (_, i) => normalized[i] ?? "");
}
