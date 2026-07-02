use aes::cipher::{BlockDecryptMut, KeyIvInit};
use blowfish::cipher::{BlockDecrypt, BlockEncrypt, KeyInit, generic_array::GenericArray};
use blowfish::Blowfish;
use cbc::Decryptor;
use sha1::{Digest, Sha1};

type Aes128CbcDec = Decryptor<aes::Aes128>;

const NAVICAT12_AES_KEY: &[u8; 16] = b"libcckeylibcckey";
const NAVICAT12_AES_IV: &[u8; 16] = b"libcciv libcciv ";

fn xor_bytes(a: &[u8], b: &[u8]) -> Vec<u8> {
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| x ^ y)
        .collect()
}

fn navicat11_blowfish() -> Blowfish {
    let digest = Sha1::digest(b"3DC5CA39");
    Blowfish::new_from_slice(&digest).expect("navicat11 blowfish key")
}

fn navicat11_initial_vector(bf: &Blowfish) -> [u8; 8] {
    let mut block = [0xffu8; 8];
    let mut ga = GenericArray::from_mut_slice(&mut block);
    bf.encrypt_block(&mut ga);
    block
}

fn decrypt_navicat11(ciphertext: &str) -> Result<String, String> {
    let data = hex::decode(ciphertext.trim()).map_err(|e| e.to_string())?;
    if data.is_empty() {
        return Ok(String::new());
    }

    let bf = navicat11_blowfish();
    let mut current_vector = navicat11_initial_vector(&bf);
    let full_blocks = data.len() / 8;
    let leftover = data.len() % 8;
    let mut result = Vec::with_capacity(data.len());

    for i in 0..full_blocks {
        let start = i * 8;
        let encrypted_block = &data[start..start + 8];
        let mut block = GenericArray::clone_from_slice(encrypted_block);
        bf.decrypt_block(&mut block);
        let plain = xor_bytes(block.as_slice(), &current_vector);
        result.extend_from_slice(&plain);
        current_vector = xor_bytes(&current_vector, encrypted_block)
            .try_into()
            .map_err(|_| "navicat11 iv update failed".to_string())?;
    }

    if leftover > 0 {
        let mut vector = current_vector;
        let mut ga = GenericArray::from_mut_slice(&mut vector);
        bf.encrypt_block(&mut ga);
        let start = full_blocks * 8;
        for (idx, byte) in data[start..].iter().enumerate() {
            result.push(byte ^ vector[idx]);
        }
    }

    String::from_utf8(result).map_err(|e| e.to_string())
}

fn decrypt_navicat12(ciphertext: &str) -> Result<String, String> {
    let mut data = hex::decode(ciphertext.trim()).map_err(|e| e.to_string())?;
    if data.is_empty() {
        return Ok(String::new());
    }
    if data.len() % 16 != 0 {
        return Err("invalid navicat12 ciphertext length".to_string());
    }

    let cipher = Aes128CbcDec::new_from_slices(NAVICAT12_AES_KEY, NAVICAT12_AES_IV)
        .map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt_padded_mut::<cbc::cipher::block_padding::Pkcs7>(&mut data)
        .map_err(|e| e.to_string())?;
    String::from_utf8(plain.to_vec()).map_err(|e| e.to_string())
}

fn is_plausible_password(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| !ch.is_control() || ch == '\t' || ch == '\n' || ch == '\r')
}

fn decrypt_navicat_password_inner(ciphertext: &str) -> Result<String, String> {
    let trimmed = ciphertext.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    if trimmed.len() >= 32 && trimmed.len() % 2 == 0 {
        if let Ok(value) = decrypt_navicat12(trimmed) {
            if is_plausible_password(&value) {
                return Ok(value);
            }
        }
    }

    decrypt_navicat11(trimmed)
}

/// 解密 Navicat 导出的连接密码（NCX / 注册表，支持 v11 Blowfish 与 v12 AES）。
#[tauri::command]
#[specta::specta]
pub fn decrypt_navicat_password(ciphertext: String) -> Result<String, String> {
    decrypt_navicat_password_inner(&ciphertext)
}

/// 批量解密 Navicat 密码；失败项返回空字符串。
#[tauri::command]
#[specta::specta]
pub fn decrypt_navicat_passwords(ciphertexts: Vec<String>) -> Vec<String> {
    ciphertexts
        .into_iter()
        .map(|item| decrypt_navicat_password_inner(&item).unwrap_or_default())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypt_navicat12_sample() {
        let plain =
            decrypt_navicat12("B75D320B6211468D63EB3B67C9E85933").expect("decrypt navicat12");
        assert_eq!(plain, "This is a test");
    }

    #[test]
    fn decrypt_navicat11_sample() {
        let plain =
            decrypt_navicat11("0EA71F51DD37BFB60CCBA219BE3A").expect("decrypt navicat11");
        assert_eq!(plain, "This is a test");
    }
}
