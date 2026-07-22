import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

interface LocalQrCodeProps {
  /** 二维码内容（原文，不加前缀） */
  payload: string;
  size?: number;
  className?: string;
  alt?: string;
}

/** 用本地库把字符串画成二维码（非微信小程序码）。 */
export function LocalQrCode({ payload, size = 200, className, alt = "" }: LocalQrCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const genIdRef = useRef(0);

  useEffect(() => {
    const trimmed = payload.trim();
    if (!trimmed) {
      setDataUrl(null);
      setError(null);
      return;
    }
    const genId = ++genIdRef.current;
    setError(null);
    void QRCode.toDataURL(trimmed, {
      width: size,
      margin: 1,
      errorCorrectionLevel: "M",
    })
      .then((url) => {
        if (genId !== genIdRef.current) return;
        setDataUrl(url);
      })
      .catch((err: unknown) => {
        if (genId !== genIdRef.current) return;
        setDataUrl(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [payload, size]);

  if (error) {
    return <div className={className}>{error}</div>;
  }
  if (!dataUrl) {
    return <div className={className} aria-busy />;
  }
  return <img src={dataUrl} alt={alt} width={size} height={size} className={className} />;
}
