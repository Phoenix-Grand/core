//! The Android secret store: the OS keystore wrapper the shell installs for the account layer.
//!
//! Each secret (a refresh token, the account book, the device key) is encrypted with AES-256-GCM under a key that lives
//! in the **Android Keystore** (`AndroidKeyStore`, hardware-backed where the device has it) and never leaves it, and
//! the ciphertext is written to a file in the app's private storage (`<internal data>/kubuno-secrets/<hex key>.bin`,
//! `IV ‖ ciphertext+tag`). Pure JNI from the NativeActivity - no Java/Kotlin of our own, no Gradle library. Uninstalling
//! the app removes both the files and the key.

use std::path::PathBuf;
use std::sync::Mutex;

use jni::objects::{JByteArray, JObject, JValue};
use jni::{jni_sig, jni_str, Env, JavaVM};
use kubuno_mobile_account::{SecretError, SecretStore};

/// The Keystore alias of the AES key that encrypts every secret.
const ALIAS: &str = "kubuno.secrets.v1";
/// AES-GCM IV length the platform cipher generates.
const IV_LEN: usize = 12;
const ENCRYPT_MODE: i32 = 1;
const DECRYPT_MODE: i32 = 2;
/// `KeyProperties.PURPOSE_ENCRYPT | PURPOSE_DECRYPT`.
const PURPOSE_ENCRYPT_DECRYPT: i32 = 1 | 2;

/// Secrets encrypted by an Android Keystore key, stored as files in the app's private directory.
pub struct AndroidSecretStore {
    dir: PathBuf,
    /// Serialises the file writes (the account layer may store from the UI thread and a network thread).
    lock: Mutex<()>,
}

impl AndroidSecretStore {
    /// A store in `dir` (created if missing), typically `<internal data path>/kubuno-secrets`.
    pub fn new(dir: PathBuf) -> Result<Self, SecretError> {
        std::fs::create_dir_all(&dir).map_err(|e| SecretError(format!("secret directory: {e}")))?;
        Ok(Self { dir, lock: Mutex::new(()) })
    }

    fn path(&self, key: &str) -> PathBuf {
        let name: String = key.bytes().map(|b| format!("{b:02x}")).collect();
        self.dir.join(format!("{name}.bin"))
    }
}

impl SecretStore for AndroidSecretStore {
    fn load(&self, key: &str) -> Result<Option<String>, SecretError> {
        let _guard = self.lock.lock().map_err(|_| SecretError("poisoned".into()))?;
        let data = match std::fs::read(self.path(key)) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(SecretError(format!("read: {e}"))),
        };
        if data.len() <= IV_LEN {
            return Err(SecretError("truncated secret".into()));
        }
        let plain = with_env(|env| decrypt(env, &data[..IV_LEN], &data[IV_LEN..]))?;
        String::from_utf8(plain).map(Some).map_err(|_| SecretError("secret is not UTF-8".into()))
    }

    fn store(&self, key: &str, value: &str) -> Result<(), SecretError> {
        let _guard = self.lock.lock().map_err(|_| SecretError("poisoned".into()))?;
        let sealed = with_env(|env| encrypt(env, value.as_bytes()))?;
        // Write then rename, so a crash never leaves a half-written secret behind.
        let path = self.path(key);
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &sealed).map_err(|e| SecretError(format!("write: {e}")))?;
        std::fs::rename(&tmp, &path).map_err(|e| SecretError(format!("rename: {e}")))
    }

    fn delete(&self, key: &str) -> Result<(), SecretError> {
        let _guard = self.lock.lock().map_err(|_| SecretError("poisoned".into()))?;
        match std::fs::remove_file(self.path(key)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(SecretError(format!("delete: {e}"))),
        }
    }
}

/// Run `f` with a JNI environment for the current thread (attached if needed) inside a local frame, clearing any Java
/// exception it raised.
fn with_env<T>(f: impl FnOnce(&mut Env) -> jni::errors::Result<T>) -> Result<T, SecretError> {
    let vm = JavaVM::singleton().map_err(|e| SecretError(format!("JVM: {e}")))?;
    vm.attach_current_thread(|env| {
        env.with_local_frame(32, |env| {
            let result = f(env);
            if result.is_err() && env.exception_check() {
                env.exception_describe();
                env.exception_clear();
            }
            result
        })
    })
    .map_err(|e: jni::errors::Error| SecretError(format!("keystore: {e}")))
}

/// The Keystore AES key, created on first use (AES-256, GCM, no padding).
fn secret_key<'l>(env: &mut Env<'l>) -> jni::errors::Result<JObject<'l>> {
    let alias = env.new_string(ALIAS)?;
    let provider = env.new_string("AndroidKeyStore")?;
    let ks = env
        .call_static_method(
            jni_str!("java/security/KeyStore"),
            jni_str!("getInstance"),
            jni_sig!("(Ljava/lang/String;)Ljava/security/KeyStore;"),
            &[(&provider).into()],
        )?
        .l()?;
    env.call_method(
        &ks,
        jni_str!("load"),
        jni_sig!("(Ljava/security/KeyStore$LoadStoreParameter;)V"),
        &[(&JObject::null()).into()],
    )?;
    let present = env
        .call_method(&ks, jni_str!("containsAlias"), jni_sig!("(Ljava/lang/String;)Z"), &[(&alias).into()])?
        .z()?;
    if present {
        return env
            .call_method(
                &ks,
                jni_str!("getKey"),
                jni_sig!("(Ljava/lang/String;[C)Ljava/security/Key;"),
                &[(&alias).into(), (&JObject::null()).into()],
            )?
            .l();
    }
    let builder = env.new_object(
        jni_str!("android/security/keystore/KeyGenParameterSpec$Builder"),
        jni_sig!("(Ljava/lang/String;I)V"),
        &[(&alias).into(), JValue::Int(PURPOSE_ENCRYPT_DECRYPT)],
    )?;
    let gcm = env.new_string("GCM")?;
    let modes = env.new_object_array(1, jni_str!("java/lang/String"), &gcm)?;
    env.call_method(
        &builder,
        jni_str!("setBlockModes"),
        jni_sig!("([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;"),
        &[(&modes).into()],
    )?;
    let no_padding = env.new_string("NoPadding")?;
    let paddings = env.new_object_array(1, jni_str!("java/lang/String"), &no_padding)?;
    env.call_method(
        &builder,
        jni_str!("setEncryptionPaddings"),
        jni_sig!("([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;"),
        &[(&paddings).into()],
    )?;
    env.call_method(
        &builder,
        jni_str!("setKeySize"),
        jni_sig!("(I)Landroid/security/keystore/KeyGenParameterSpec$Builder;"),
        &[JValue::Int(256)],
    )?;
    let spec = env
        .call_method(&builder, jni_str!("build"), jni_sig!("()Landroid/security/keystore/KeyGenParameterSpec;"), &[])?
        .l()?;
    let aes = env.new_string("AES")?;
    let generator = env
        .call_static_method(
            jni_str!("javax/crypto/KeyGenerator"),
            jni_str!("getInstance"),
            jni_sig!("(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/KeyGenerator;"),
            &[(&aes).into(), (&provider).into()],
        )?
        .l()?;
    env.call_method(
        &generator,
        jni_str!("init"),
        jni_sig!("(Ljava/security/spec/AlgorithmParameterSpec;)V"),
        &[(&spec).into()],
    )?;
    env.call_method(&generator, jni_str!("generateKey"), jni_sig!("()Ljavax/crypto/SecretKey;"), &[])?.l()
}

fn cipher<'l>(env: &mut Env<'l>) -> jni::errors::Result<JObject<'l>> {
    let transformation = env.new_string("AES/GCM/NoPadding")?;
    env.call_static_method(
        jni_str!("javax/crypto/Cipher"),
        jni_str!("getInstance"),
        jni_sig!("(Ljava/lang/String;)Ljavax/crypto/Cipher;"),
        &[(&transformation).into()],
    )?
    .l()
}

fn bytes(env: &mut Env, obj: JObject) -> jni::errors::Result<Vec<u8>> {
    let array = env.cast_local::<JByteArray>(obj)?;
    env.convert_byte_array(&array)
}

/// Encrypt `plain`: returns `IV ‖ ciphertext+tag` (the platform picks a fresh IV).
fn encrypt(env: &mut Env, plain: &[u8]) -> jni::errors::Result<Vec<u8>> {
    let key = secret_key(env)?;
    let cipher = cipher(env)?;
    env.call_method(
        &cipher,
        jni_str!("init"),
        jni_sig!("(ILjava/security/Key;)V"),
        &[JValue::Int(ENCRYPT_MODE), (&key).into()],
    )?;
    let iv = env.call_method(&cipher, jni_str!("getIV"), jni_sig!("()[B"), &[])?.l()?;
    let mut out = bytes(env, iv)?;
    let input = env.byte_array_from_slice(plain)?;
    let sealed = env.call_method(&cipher, jni_str!("doFinal"), jni_sig!("([B)[B"), &[(&input).into()])?.l()?;
    out.extend(bytes(env, sealed)?);
    Ok(out)
}

/// Decrypt `ciphertext` (with its tag) under `iv`.
fn decrypt(env: &mut Env, iv: &[u8], ciphertext: &[u8]) -> jni::errors::Result<Vec<u8>> {
    let key = secret_key(env)?;
    let cipher = cipher(env)?;
    let iv = env.byte_array_from_slice(iv)?;
    let spec = env.new_object(
        jni_str!("javax/crypto/spec/GCMParameterSpec"),
        jni_sig!("(I[B)V"),
        &[JValue::Int(128), (&iv).into()],
    )?;
    env.call_method(
        &cipher,
        jni_str!("init"),
        jni_sig!("(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V"),
        &[JValue::Int(DECRYPT_MODE), (&key).into(), (&spec).into()],
    )?;
    let input = env.byte_array_from_slice(ciphertext)?;
    let plain = env.call_method(&cipher, jni_str!("doFinal"), jni_sig!("([B)[B"), &[(&input).into()])?.l()?;
    bytes(env, plain)
}
