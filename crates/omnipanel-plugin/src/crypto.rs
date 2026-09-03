//! L2 宿主本地密码学：插件签厂商 API 用，不经网络、不需权限。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha1::Sha1;
use sha2::Sha256;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HmacSpec {
    alg: String,
    key: String,
    data: String,
    #[serde(default = "default_encoding")]
    encoding: String,
}

fn default_encoding() -> String {
    "hex".into()
}

/// `spec_json`: `{ alg: "sha256"|"sha1", key, data, encoding?: "hex"|"base64" }`
pub fn hmac_digest(spec_json: &str) -> Result<String, String> {
    let spec: HmacSpec = serde_json::from_str(spec_json)
        .map_err(|e| format!("hmac 参数需为 {{alg,key,data,encoding?}} JSON: {e}"))?;
    let alg = spec.alg.trim().to_ascii_lowercase();
    let digest = match alg.as_str() {
        "sha256" | "hmac-sha256" | "hmac_sha256" => {
            let mut mac = Hmac::<Sha256>::new_from_slice(spec.key.as_bytes())
                .map_err(|e| format!("hmac key: {e}"))?;
            mac.update(spec.data.as_bytes());
            mac.finalize().into_bytes().to_vec()
        }
        "sha1" | "hmac-sha1" | "hmac_sha1" => {
            let mut mac = Hmac::<Sha1>::new_from_slice(spec.key.as_bytes())
                .map_err(|e| format!("hmac key: {e}"))?;
            mac.update(spec.data.as_bytes());
            mac.finalize().into_bytes().to_vec()
        }
        other => return Err(format!("不支持的 hmac alg: {other}")),
    };
    match spec.encoding.trim().to_ascii_lowercase().as_str() {
        "hex" | "" => Ok(hex::encode(digest)),
        "base64" => Ok(STANDARD.encode(digest)),
        other => Err(format!("不支持的 hmac encoding: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_sha256_rfc_vector() {
        let out = hmac_digest(
            r#"{"alg":"sha256","key":"key","data":"The quick brown fox jumps over the lazy dog"}"#,
        )
        .expect("hmac");
        assert_eq!(
            out,
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn hmac_sha1_hex_and_base64() {
        let hex = hmac_digest(r#"{"alg":"sha1","key":"key","data":"The quick brown fox jumps over the lazy dog"}"#)
            .expect("hmac");
        assert_eq!(hex, "de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9");
        let b64 = hmac_digest(
            r#"{"alg":"sha1","key":"key","data":"The quick brown fox jumps over the lazy dog","encoding":"base64"}"#,
        )
        .expect("hmac");
        assert_eq!(b64, "3nybhbi3iqa8ino29wqQcBydtNk=");
    }

    #[test]
    fn hmac_rejects_unknown_alg() {
        assert!(hmac_digest(r#"{"alg":"md5","key":"k","data":"d"}"#)
            .unwrap_err()
            .contains("不支持"));
    }
}
