//! The encryption key lives only in the operating system credential store.
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const AAD: &[u8] = b"codex-switcher-cn/accounts/v1";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub vault_version: u32,
    nonce: String,
    ciphertext: String,
}

fn key(create: bool) -> Result<Zeroizing<Vec<u8>>> {
    let entry = keyring::Entry::new("com.duiwei996.codex-switcher-cn", "account-vault-v1")
        .map_err(|_| anyhow::anyhow!("System credential store could not be opened"))?;
    let bytes = match entry.get_secret() {
        Ok(bytes) => bytes,
        Err(keyring::Error::NoEntry) if create => {
            let mut bytes = Zeroizing::new(vec![0u8; 32]); rand::rng().fill_bytes(&mut bytes);
            entry.set_secret(&bytes).map_err(|_| anyhow::anyhow!("System credential store could not save the account key"))?;
            // Check persistence before replacing any legacy plaintext file.
            let saved = entry.get_secret().map_err(|_| anyhow::anyhow!("System credential store could not verify the saved key"))?;
            if saved.as_slice() != bytes.as_slice() { anyhow::bail!("System credential store key verification failed"); }
            saved
        }
        Err(_) => anyhow::bail!("Account encryption key is unavailable. Unlock the system credential store; if the key is lost, preserve the old account file and reconfigure accounts from exported JSON or sign in again"),
    };
    if bytes.len() != 32 {
        anyhow::bail!("Account encryption key has an invalid length");
    }
    Ok(Zeroizing::new(bytes))
}

fn encrypt_with_key(data: &[u8], key: &[u8]) -> Result<Envelope> {
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| anyhow::anyhow!("Invalid encryption key"))?;
    let mut nonce = [0u8; 24];
    rand::rng().fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: data,
                aad: AAD,
            },
        )
        .map_err(|_| anyhow::anyhow!("Could not encrypt account data"))?;
    Ok(Envelope {
        vault_version: 1,
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
}
fn decrypt_with_key(data: &Envelope, key: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if data.vault_version != 1 {
        anyhow::bail!("Unsupported encrypted account format");
    }
    let nonce = STANDARD
        .decode(&data.nonce)
        .context("Invalid account nonce")?;
    if nonce.len() != 24 {
        anyhow::bail!("Invalid account nonce length");
    }
    let ciphertext = STANDARD
        .decode(&data.ciphertext)
        .context("Invalid encrypted account data")?;
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| anyhow::anyhow!("Invalid encryption key"))?;
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: AAD,
            },
        )
        .map_err(|_| {
            anyhow::anyhow!(
                "Account data failed authentication. Preserve the old account file and reconfigure accounts from exported JSON or sign in again"
            )
        })?;
    Ok(Zeroizing::new(plaintext))
}
pub fn encode(data: &[u8], create: bool) -> Result<Vec<u8>> {
    let key = key(create)?;
    let envelope = encrypt_with_key(data, &key)?;
    if decrypt_with_key(&envelope, &key)?.as_slice() != data {
        anyhow::bail!("Encrypted account verification failed");
    }
    Ok(serde_json::to_vec_pretty(&envelope)?)
}
pub fn decode(data: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let envelope: Envelope =
        serde_json::from_slice(data).context("Invalid encrypted account envelope")?;
    decrypt_with_key(&envelope, &key(false)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn windows_credential_store_roundtrip_uses_an_isolated_test_entry() {
        let entry = keyring::Entry::new(
            "codex-switcher-unit-test",
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        entry.set_secret(b"public-synthetic-test-value").unwrap();
        let result = entry.get_secret();
        entry.delete_credential().unwrap();
        assert_eq!(result.unwrap(), b"public-synthetic-test-value");
    }
    #[test]
    fn roundtrip_tampering_wrong_key_and_nonce() {
        let key = [42u8; 32];
        let mut envelope = encrypt_with_key(b"secret-token", &key).unwrap();
        assert_eq!(
            &*decrypt_with_key(&envelope, &key).unwrap(),
            b"secret-token"
        );
        assert!(!serde_json::to_string(&envelope)
            .unwrap()
            .contains("secret-token"));
        assert!(decrypt_with_key(&envelope, &[43u8; 32]).is_err());
        envelope.nonce = STANDARD.encode([0u8; 2]);
        assert!(decrypt_with_key(&envelope, &key).is_err());
        let mut envelope = encrypt_with_key(b"secret-token", &key).unwrap();
        let mut bytes = STANDARD.decode(&envelope.ciphertext).unwrap();
        bytes[0] ^= 1;
        envelope.ciphertext = STANDARD.encode(bytes);
        assert!(decrypt_with_key(&envelope, &key).is_err());
    }
}
