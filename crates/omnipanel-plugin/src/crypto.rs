//! L2 宿主本地密码学：插件签厂商 API 用，不经网络、不需权限。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha1::Sha1;
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HmacSpec {
    alg: String,
    key: String,
    data: String,
    #[serde(default = "default_encoding")]
    encoding: String,
    #[serde(default = "default_bytes_encoding")]
    key_encoding: String,
    #[serde(default = "default_bytes_encoding")]
    data_encoding: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashSpec {
    alg: String,
    data: String,
    #[serde(default = "default_encoding")]
    encoding: String,
    #[serde(default = "default_bytes_encoding")]
    data_encoding: String,
}

fn default_encoding() -> String {
    "hex".into()
}

fn default_bytes_encoding() -> String {
    "utf8".into()
}

fn decode_bytes(value: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding.trim().to_ascii_lowercase().as_str() {
        "utf8" | "utf-8" | "" => Ok(value.as_bytes().to_vec()),
        "hex" => hex::decode(value.trim()).map_err(|e| format!("hex 解码失败: {e}")),
        "base64" => STANDARD
            .decode(value.trim())
            .map_err(|e| format!("base64 解码失败: {e}")),
        other => Err(format!("不支持的字节编码: {other}")),
    }
}

fn encode_digest(digest: &[u8], encoding: &str) -> Result<String, String> {
    match encoding.trim().to_ascii_lowercase().as_str() {
        "hex" | "" => Ok(hex::encode(digest)),
        "base64" => Ok(STANDARD.encode(digest)),
        other => Err(format!("不支持的 hmac encoding: {other}")),
    }
}

/// `spec_json`: `{ alg, key, data, encoding?, keyEncoding?, dataEncoding? }`
pub fn hmac_digest(spec_json: &str) -> Result<String, String> {
    let spec: HmacSpec = serde_json::from_str(spec_json)
        .map_err(|e| format!("hmac 参数需为 {{alg,key,data,encoding?}} JSON: {e}"))?;
    let key = decode_bytes(&spec.key, &spec.key_encoding)?;
    let data = decode_bytes(&spec.data, &spec.data_encoding)?;
    let alg = spec.alg.trim().to_ascii_lowercase();
    let digest = match alg.as_str() {
        "sha256" | "hmac-sha256" | "hmac_sha256" => {
            let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|e| format!("hmac key: {e}"))?;
            mac.update(&data);
            mac.finalize().into_bytes().to_vec()
        }
        "sha1" | "hmac-sha1" | "hmac_sha1" => {
            let mut mac = Hmac::<Sha1>::new_from_slice(&key).map_err(|e| format!("hmac key: {e}"))?;
            mac.update(&data);
            mac.finalize().into_bytes().to_vec()
        }
        other => return Err(format!("不支持的 hmac alg: {other}")),
    };
    encode_digest(&digest, &spec.encoding)
}

/// `spec_json`: `{ alg: "sha256"|"sha1", data, encoding?, dataEncoding? }`
pub fn hash_digest(spec_json: &str) -> Result<String, String> {
    let spec: HashSpec = serde_json::from_str(spec_json)
        .map_err(|e| format!("hash 参数需为 {{alg,data,encoding?}} JSON: {e}"))?;
    let data = decode_bytes(&spec.data, &spec.data_encoding)?;
    let digest = match spec.alg.trim().to_ascii_lowercase().as_str() {
        "sha256" => Sha256::digest(&data).to_vec(),
        "sha1" => Sha1::digest(&data).to_vec(),
        other => return Err(format!("不支持的 hash alg: {other}")),
    };
    encode_digest(&digest, &spec.encoding)
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

    #[test]
    fn hmac_hex_key_matches_raw_bytes() {
        let secret_date = hmac_digest(r#"{"alg":"sha256","key":"TC3secret","data":"2026-01-02"}"#)
            .expect("kDate");
        let nested = hmac_digest(&format!(
            r#"{{"alg":"sha256","key":"{secret_date}","data":"cvm","keyEncoding":"hex"}}"#
        ))
        .expect("kService");
        assert_eq!(nested.len(), 64);
    }

    #[test]
    fn sha256_empty_is_fixed() {
        let out = hash_digest(r#"{"alg":"sha256","data":""}"#).expect("hash");
        assert_eq!(
            out,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
