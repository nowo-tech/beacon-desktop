//! TLS public-key (SPKI) pinning for the official Beacon host(s). See docs/PINNING.md.
//!
//! Every Beacon request of the app goes through Rust (`net.rs`) with [`PinningVerifier`]: first the normal WebPKI
//! validation (chain to a root of the compiled-in Mozilla store, validity dates, server name), then, only for the hosts
//! listed in `pins.json`, a valid path from the presented certificate to a trust anchor must contain a CA key whose
//! SPKI SHA-256 is in the pin set. A TLS-inspecting proxy or a rogue CA trusted by the OS therefore cannot read or
//! modify the traffic to those hosts: the handshake fails before any request (and its Bearer token) is sent.
//!
//! Other hosts (self-hosted Beacon) keep the normal WebPKI validation; loopback is never pinned. A pin set past its
//! expiry date stops being enforced (the app shows "update the app" in Settings) instead of locking old installs out;
//! new pins only arrive with a signed app update.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, LazyLock};

use base64::Engine as _;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, OtherError, RootCertStore, SignatureScheme};

/// Marker of a pin mismatch in error messages; the UI maps it to "La conexión con Beacon no es de confianza
/// (certificado inesperado)" (src/lib/errors.ts). Keep both in step.
pub const UNTRUSTED_MARKER: &str = "beacon_untrusted_certificate";

/// The pin set shipped in this build.
const SHIPPED_PINS: &str = include_str!("../pins.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PinFile {
    #[serde(rename = "$comment", default)]
    _comment: String,
    version: u32,
    issued: String,
    expires: String,
    hosts: Vec<String>,
    pins: Vec<PinEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PinEntry {
    sha256: String,
    label: String,
}

/// A validated pin set: hosts it covers, SPKI SHA-256 values, version and expiry (Unix seconds, 00:00 UTC).
#[derive(Debug, Clone)]
pub struct PinSet {
    pub version: u32,
    pub expires_at: u64,
    hosts: Vec<String>,
    pins: Vec<[u8; 32]>,
}

/// How the connection to a server is protected (shown in Settings).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PinStatus {
    /// Official host, pin set in force: CA keys are pinned.
    Pinned,
    /// Any other host: normal WebPKI validation only.
    Unpinned,
    /// Official host, but this build's pin set expired: normal WebPKI validation until the app is updated.
    Expired,
    /// Loopback (development): never pinned.
    Local,
}

impl PinSet {
    /// Parses and validates a pin file. Rejects: no host, a wildcard / IP / uppercase host, fewer than two pins, a pin
    /// that is not 32 bytes of base64, duplicates, dates that are not `YYYY-MM-DD` or an expiry before the issue date.
    pub fn parse(json: &str) -> Result<Self, String> {
        let file: PinFile = serde_json::from_str(json).map_err(|e| format!("pin file: {e}"))?;
        if file.version == 0 {
            return Err("pin file: version must be >= 1".into());
        }
        let issued_at = parse_date(&file.issued)?;
        let expires_at = parse_date(&file.expires)?;
        if expires_at <= issued_at {
            return Err("pin file: expires must be after issued".into());
        }
        if file.hosts.is_empty() {
            return Err("pin file: no host".into());
        }
        for host in &file.hosts {
            let valid = !host.is_empty()
                && host.contains('.')
                && host.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.'
                })
                && !host.bytes().all(|b| b.is_ascii_digit() || b == b'.')
                && !is_loopback(host);
            if !valid {
                return Err(format!("pin file: invalid host {host:?}"));
            }
        }
        let mut pins = Vec::with_capacity(file.pins.len());
        for entry in &file.pins {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(entry.sha256.trim())
                .map_err(|_| format!("pin file: {} is not base64", entry.label))?;
            let pin: [u8; 32] = bytes
                .try_into()
                .map_err(|_| format!("pin file: {} is not a SHA-256", entry.label))?;
            if pins.contains(&pin) {
                return Err(format!("pin file: duplicate pin {}", entry.label));
            }
            pins.push(pin);
        }
        if pins.len() < 2 {
            return Err("pin file: at least two pins (one backup) are required".into());
        }
        Ok(Self {
            version: file.version,
            expires_at,
            hosts: file.hosts,
            pins,
        })
    }

    /// The pin set compiled into this build (`src-tauri/pins.json`); a test checks it parses.
    pub fn shipped() -> Arc<PinSet> {
        static SHIPPED: LazyLock<Arc<PinSet>> =
            LazyLock::new(|| Arc::new(PinSet::parse(SHIPPED_PINS).expect("src-tauri/pins.json")));
        SHIPPED.clone()
    }

    /// The SHA-256 values, for the tests.
    #[cfg(test)]
    pub fn pins(&self) -> &[[u8; 32]] {
        &self.pins
    }

    #[cfg(test)]
    pub fn hosts(&self) -> &[String] {
        &self.hosts
    }

    /// True when `host` is one of the pinned hosts (exact name, case-insensitive, trailing dot ignored).
    /// The official Beacon host of this build (the first pinned host), for the sign-in confirmation.
    pub fn official_host(&self) -> Option<&str> {
        self.hosts.first().map(String::as_str)
    }

    pub fn covers(&self, host: &str) -> bool {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        self.hosts.contains(&host)
    }

    /// How a connection to `host` is protected at `now` (Unix seconds).
    pub fn status(&self, host: &str, now: u64) -> PinStatus {
        if is_loopback(host) {
            PinStatus::Local
        } else if !self.covers(host) {
            PinStatus::Unpinned
        } else if now >= self.expires_at {
            PinStatus::Expired
        } else {
            PinStatus::Pinned
        }
    }

    /// True when the SHA-256 of `spki` (DER, with its outer SEQUENCE) is pinned.
    pub fn matches(&self, spki: &[u8]) -> bool {
        let digest = spki_sha256(spki);
        self.pins.contains(&digest)
    }
}

/// SHA-256 of a DER `SubjectPublicKeyInfo` (what `openssl pkey -pubin -outform der | openssl dgst -sha256` hashes).
pub fn spki_sha256(spki: &[u8]) -> [u8; 32] {
    let digest = ring::digest::digest(&ring::digest::SHA256, spki);
    digest.as_ref().try_into().expect("SHA-256 is 32 bytes")
}

/// Loopback names and addresses: development servers, never pinned.
pub fn is_loopback(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host.ends_with(".localhost")
        || bare
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// `YYYY-MM-DD` → Unix seconds at 00:00 UTC.
fn parse_date(value: &str) -> Result<u64, String> {
    let invalid = || format!("pin file: invalid date {value:?}");
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return Err(invalid());
    }
    let number = |s: &str| s.parse::<i64>().map_err(|_| invalid());
    let (y, m, d) = (number(parts[0])?, number(parts[1])?, number(parts[2])?);
    if !(1970..=9999).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(invalid());
    }
    // Days from civil (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Ok((days * 86_400) as u64)
}

/// DER SEQUENCE around `content` (webpki keeps a trust anchor's SPKI without its outer tag and length).
fn der_sequence(content: &[u8]) -> Vec<u8> {
    let len = content.len();
    let mut out = Vec::with_capacity(len + 4);
    out.push(0x30);
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let bytes: Vec<u8> = len
            .to_be_bytes()
            .into_iter()
            .skip_while(|b| *b == 0)
            .collect();
        out.push(0x80 | bytes.len() as u8);
        out.extend_from_slice(&bytes);
    }
    out.extend_from_slice(content);
    out
}

/// The handshake failed on a pinned host because no pinned CA key is in a valid chain. Only the host and the pin
/// set version are kept (logged, and shown in "Copy details"); never a token or a URL.
pub struct PinMismatch {
    pub host: String,
    pub version: u32,
}

impl std::fmt::Display for PinMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{UNTRUSTED_MARKER}: unexpected certificate for {} (pin set v{})",
            self.host, self.version
        )
    }
}

// rustls shows the cause of `InvalidCertificate(Other(..))` with `Debug`: same text as `Display`, so the marker
// reaches the error string of the UI.
impl std::fmt::Debug for PinMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

impl std::error::Error for PinMismatch {}

/// WebPKI validation, plus the pin check for the pinned hosts (fail closed, no fallback).
#[derive(Debug)]
pub struct PinningVerifier {
    inner: Arc<WebPkiServerVerifier>,
    roots: Arc<RootCertStore>,
    pins: Arc<PinSet>,
    provider: Arc<CryptoProvider>,
}

impl PinningVerifier {
    pub fn new(
        roots: Arc<RootCertStore>,
        pins: Arc<PinSet>,
        provider: Arc<CryptoProvider>,
    ) -> Result<Self, String> {
        let inner = WebPkiServerVerifier::builder_with_provider(roots.clone(), provider.clone())
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            inner,
            roots,
            pins,
            provider,
        })
    }

    /// True when some valid path from `end_entity` to a trust anchor has a pinned CA key (an intermediate or the
    /// anchor). The path search goes on through alternative chains (cross-signs) until one matches.
    fn pinned_path_exists(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        now: UnixTime,
    ) -> bool {
        let Ok(cert) = webpki::EndEntityCert::try_from(end_entity) else {
            return false;
        };
        let check = |path: &webpki::VerifiedPath<'_>| -> Result<(), webpki::Error> {
            let anchor = der_sequence(path.anchor().subject_public_key_info.as_ref());
            let pinned = self.pins.matches(&anchor)
                || path
                    .intermediate_certificates()
                    .any(|ca| self.pins.matches(ca.subject_public_key_info().as_ref()));
            if pinned {
                Ok(())
            } else {
                Err(webpki::Error::UnknownIssuer)
            }
        };
        cert.verify_for_usage(
            self.provider.signature_verification_algorithms.all,
            &self.roots.roots,
            intermediates,
            now,
            webpki::KeyUsage::server_auth(),
            None,
            Some(&check),
        )
        .is_ok()
    }
}

impl ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let verified = self.inner.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        )?;
        let ServerName::DnsName(name) = server_name else {
            return Ok(verified);
        };
        let host = name.as_ref();
        if self.pins.status(host, now.as_secs()) != PinStatus::Pinned
            || self.pinned_path_exists(end_entity, intermediates, now)
        {
            return Ok(verified);
        }
        let mismatch = PinMismatch {
            host: host.to_ascii_lowercase(),
            version: self.pins.version,
        };
        // Non-sensitive event: host and pin set version only.
        eprintln!("[tls-pinning] {mismatch}");
        Err(rustls::Error::InvalidCertificate(CertificateError::Other(
            OtherError(Arc::new(mismatch)),
        )))
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// The roots of the compiled-in Mozilla store (webpki-roots): the OS store is not consulted, so a CA added to it
/// (rogue, or a TLS-inspecting proxy's) is not trusted by the app at all.
pub fn shipped_roots() -> Arc<RootCertStore> {
    static ROOTS: LazyLock<Arc<RootCertStore>> = LazyLock::new(|| {
        Arc::new(RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        })
    });
    ROOTS.clone()
}

/// TLS client configuration with [`PinningVerifier`] (ring provider, TLS 1.2+, HTTP/1.1 ALPN).
pub fn client_config(
    roots: Arc<RootCertStore>,
    pins: Arc<PinSet>,
) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = PinningVerifier::new(roots, pins, provider.clone())?;
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

/// The configuration of this build: Mozilla roots + `pins.json`.
pub fn shipped_client_config() -> rustls::ClientConfig {
    static CONFIG: LazyLock<rustls::ClientConfig> = LazyLock::new(|| {
        client_config(shipped_roots(), PinSet::shipped()).expect("TLS configuration")
    });
    CONFIG.clone()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use rcgen::{
        BasicConstraints, CertificateParams, CertifiedIssuer, DnType, ExtendedKeyUsagePurpose,
        IsCa, KeyPair, KeyUsagePurpose,
    };

    /// A CA generated at test time (nothing is committed).
    pub struct TestCa {
        pub issuer: CertifiedIssuer<'static, KeyPair>,
        pub spki_pin: String,
    }

    impl TestCa {
        pub fn new(name: &str) -> Self {
            let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
            params.distinguished_name.push(DnType::CommonName, name);
            params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
            let key = KeyPair::generate().unwrap();
            let spki_pin = pin_of(&rcgen::PublicKeyData::subject_public_key_info(&key));
            let issuer = CertifiedIssuer::self_signed(params, key).unwrap();
            Self { issuer, spki_pin }
        }

        pub fn der(&self) -> CertificateDer<'static> {
            self.issuer.der().clone()
        }

        pub fn roots(&self) -> Arc<RootCertStore> {
            let mut roots = RootCertStore::empty();
            roots.add(self.der()).unwrap();
            Arc::new(roots)
        }

        /// A server certificate for `host` and its key.
        pub fn leaf(&self, host: &str) -> (CertificateDer<'static>, KeyPair) {
            let mut params = CertificateParams::new(vec![host.to_string()]).unwrap();
            params.distinguished_name.push(DnType::CommonName, host);
            params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
            let key = KeyPair::generate().unwrap();
            let cert = params.signed_by(&key, &self.issuer).unwrap();
            (cert.der().clone(), key)
        }

        /// An intermediate CA signed by this one.
        pub fn intermediate(&self, name: &str) -> TestCa {
            let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
            params.distinguished_name.push(DnType::CommonName, name);
            params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
            let key = KeyPair::generate().unwrap();
            let spki_pin = pin_of(&rcgen::PublicKeyData::subject_public_key_info(&key));
            let issuer = CertifiedIssuer::signed_by(params, key, &self.issuer).unwrap();
            TestCa { issuer, spki_pin }
        }
    }

    pub fn pin_of(spki: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(spki_sha256(spki))
    }

    /// A pin file for `hosts` with `pins` (plus two never-matching fillers: a pin file needs at least two pins).
    pub fn pin_set(hosts: &[&str], pins: &[&str], expires: &str) -> Arc<PinSet> {
        let mut all: Vec<String> = pins.iter().map(|p| p.to_string()).collect();
        all.push(base64::engine::general_purpose::STANDARD.encode([7u8; 32]));
        all.push(base64::engine::general_purpose::STANDARD.encode([8u8; 32]));
        let json = serde_json::json!({
            "version": 9,
            "issued": "2000-01-01",
            "expires": expires,
            "hosts": hosts,
            "pins": all.iter().enumerate().map(|(i, p)| serde_json::json!({"sha256": p, "label": format!("pin {i}")})).collect::<Vec<_>>(),
        });
        Arc::new(PinSet::parse(&json.to_string()).unwrap())
    }

    fn now() -> UnixTime {
        UnixTime::now()
    }

    fn verify(
        verifier: &PinningVerifier,
        chain: &[CertificateDer<'static>],
        host: &str,
    ) -> Result<ServerCertVerified, rustls::Error> {
        verifier.verify_server_cert(
            &chain[0],
            &chain[1..],
            &ServerName::try_from(host.to_string()).unwrap(),
            &[],
            now(),
        )
    }

    fn verifier(roots: Arc<RootCertStore>, pins: Arc<PinSet>) -> PinningVerifier {
        PinningVerifier::new(
            roots,
            pins,
            Arc::new(rustls::crypto::ring::default_provider()),
        )
        .unwrap()
    }

    fn is_mismatch(error: &rustls::Error) -> bool {
        error.to_string().contains(UNTRUSTED_MARKER)
    }

    const HOST: &str = "beacon.test.example";

    #[test]
    fn shipped_pin_set_is_valid_and_covers_the_production_host() {
        let pins = PinSet::shipped();
        assert!(pins.version >= 1);
        assert!(pins.covers("beacon.nowo.tech"));
        assert!(pins.covers("BEACON.nowo.tech."));
        assert!(!pins.covers("evil.beacon.nowo.tech"));
        assert!(
            pins.pins().len() >= 3,
            "primary CA + at least one backup CA"
        );
        // CI tripwire: ship a new pin set (docs/PINNING.md) at least 90 days before this one expires.
        let ninety_days = 90 * 86_400;
        assert!(
            UnixTime::now().as_secs() + ninety_days < pins.expires_at,
            "pins.json expires within 90 days: rotate it (docs/PINNING.md)"
        );
        // Shipped hosts are pinned, never localhost.
        assert!(pins.hosts().iter().all(|host| !is_loopback(host)));
    }

    #[test]
    fn shipped_pins_include_a_backup_ca() {
        let file: serde_json::Value = serde_json::from_str(SHIPPED_PINS).unwrap();
        let labels: Vec<String> = file["pins"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pin| pin["label"].as_str().unwrap().to_string())
            .collect();
        assert!(labels.iter().any(|l| l.contains("ISRG")));
        assert!(labels.iter().any(|l| l.contains("backup")));
    }

    #[test]
    fn parse_rejects_bad_files() {
        let good = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
        let other = base64::engine::general_purpose::STANDARD.encode([2u8; 32]);
        let file = |version: u32, issued: &str, expires: &str, hosts: &[&str], pins: &[&str]| {
            serde_json::json!({
                "version": version, "issued": issued, "expires": expires, "hosts": hosts,
                "pins": pins.iter().map(|p| serde_json::json!({"sha256": p, "label": "x"})).collect::<Vec<_>>(),
            })
            .to_string()
        };
        let pins = [good.as_str(), other.as_str()];
        assert!(PinSet::parse(&file(1, "2026-01-01", "2027-01-01", &["a.example"], &pins)).is_ok());
        for bad in [
            file(0, "2026-01-01", "2027-01-01", &["a.example"], &pins),
            file(1, "2026-01-01", "2025-01-01", &["a.example"], &pins),
            file(1, "2026-1-01", "2027-01-01", &["a.example"], &pins),
            file(1, "2026-13-01", "2027-01-01", &["a.example"], &pins),
            file(1, "2026-01-xx", "2027-01-01", &["a.example"], &pins),
            file(1, "2026-01-01", "2027-01-01", &[], &pins),
            file(1, "2026-01-01", "2027-01-01", &["*.example"], &pins),
            file(1, "2026-01-01", "2027-01-01", &["A.example"], &pins),
            file(1, "2026-01-01", "2027-01-01", &["127.0.0.1"], &pins),
            file(1, "2026-01-01", "2027-01-01", &["localhost"], &pins),
            file(1, "2026-01-01", "2027-01-01", &["dev.localhost"], &pins),
            file(1, "2026-01-01", "2027-01-01", &["a.example"], &[good.as_str()]),
            file(1, "2026-01-01", "2027-01-01", &["a.example"], &[good.as_str(), good.as_str()]),
            file(1, "2026-01-01", "2027-01-01", &["a.example"], &[good.as_str(), "not base64!"]),
            file(1, "2026-01-01", "2027-01-01", &["a.example"], &[good.as_str(), "AAAA"]),
            "{}".to_string(),
            r#"{"version":1,"issued":"2026-01-01","expires":"2027-01-01","hosts":["a.example"],"pins":[],"extra":1}"#.to_string(),
        ] {
            assert!(PinSet::parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn dates_are_utc_midnight() {
        assert_eq!(parse_date("1970-01-01"), Ok(0));
        assert_eq!(parse_date("2000-03-01"), Ok(951_868_800));
        assert_eq!(parse_date("2028-05-01"), Ok(1_840_752_000));
    }

    #[test]
    fn der_sequence_lengths() {
        assert_eq!(der_sequence(&[1, 2]), vec![0x30, 2, 1, 2]);
        let long = vec![0u8; 300];
        let wrapped = der_sequence(&long);
        assert_eq!(&wrapped[..4], &[0x30, 0x82, 0x01, 0x2c]);
        assert_eq!(wrapped.len(), 304);
        assert_eq!(&der_sequence(&[0u8; 200])[..3], &[0x30, 0x81, 200]);
    }

    #[test]
    fn status_per_host() {
        let pins = pin_set(&[HOST], &[], "2999-01-01");
        let now = UnixTime::now().as_secs();
        assert_eq!(pins.status(HOST, now), PinStatus::Pinned);
        assert_eq!(pins.status("self-hosted.example", now), PinStatus::Unpinned);
        assert_eq!(pins.status(HOST, pins.expires_at), PinStatus::Expired);
        for local in ["localhost", "127.0.0.1", "[::1]", "::1", "dev.localhost"] {
            assert_eq!(pins.status(local, now), PinStatus::Local, "{local}");
        }
    }

    #[test]
    fn pinned_root_matches() {
        let ca = TestCa::new("Test Root");
        let (leaf, _) = ca.leaf(HOST);
        let v = verifier(ca.roots(), pin_set(&[HOST], &[&ca.spki_pin], "2999-01-01"));
        assert!(verify(&v, &[leaf], HOST).is_ok());
    }

    #[test]
    fn pinned_intermediate_matches() {
        let root = TestCa::new("Test Root");
        let int = root.intermediate("Test Intermediate");
        let (leaf, _) = int.leaf(HOST);
        let v = verifier(
            root.roots(),
            pin_set(&[HOST], &[&int.spki_pin], "2999-01-01"),
        );
        assert!(verify(&v, &[leaf, int.der()], HOST).is_ok());
    }

    #[test]
    fn wrong_ca_is_refused_on_a_pinned_host() {
        // Both CAs are trusted (a rogue CA in the trust store, or a TLS-inspecting proxy): WebPKI alone accepts the
        // rogue chain, the pin check refuses it.
        let official = TestCa::new("Official Root");
        let rogue = TestCa::new("Rogue Root");
        let mut roots = RootCertStore::empty();
        roots.add(official.der()).unwrap();
        roots.add(rogue.der()).unwrap();
        let (leaf, _) = rogue.leaf(HOST);
        let v = verifier(
            Arc::new(roots),
            pin_set(&[HOST], &[&official.spki_pin], "2999-01-01"),
        );
        let error = verify(&v, &[leaf], HOST).unwrap_err();
        assert!(is_mismatch(&error), "{error}");
        assert!(error.to_string().contains(HOST));
        assert!(error.to_string().contains("pin set v9"));
    }

    #[test]
    fn leaf_key_is_never_a_pin() {
        // A pin equal to the leaf key does not count: only CA keys are checked.
        let ca = TestCa::new("Test Root");
        let (leaf, key) = ca.leaf(HOST);
        let v = verifier(
            ca.roots(),
            pin_set(
                &[HOST],
                &[&pin_of(&rcgen::PublicKeyData::subject_public_key_info(
                    &key,
                ))],
                "2999-01-01",
            ),
        );
        assert!(is_mismatch(&verify(&v, &[leaf], HOST).unwrap_err()));
    }

    #[test]
    fn backup_pin_matches() {
        // The production CA is not the first pin: a certificate from the backup CA still connects.
        let primary = TestCa::new("Primary Root");
        let backup = TestCa::new("Backup Root");
        let (leaf, _) = backup.leaf(HOST);
        let v = verifier(
            backup.roots(),
            pin_set(
                &[HOST],
                &[&primary.spki_pin, &backup.spki_pin],
                "2999-01-01",
            ),
        );
        assert!(verify(&v, &[leaf], HOST).is_ok());
    }

    #[test]
    fn expired_pin_set_falls_back_to_webpki() {
        let official = TestCa::new("Official Root");
        let other = TestCa::new("Other Root");
        let (leaf, _) = other.leaf(HOST);
        let v = verifier(
            other.roots(),
            pin_set(&[HOST], &[&official.spki_pin], "2020-01-01"),
        );
        assert!(verify(&v, &[leaf], HOST).is_ok());
    }

    #[test]
    fn unpinned_host_uses_webpki_only() {
        let official = TestCa::new("Official Root");
        let other = TestCa::new("Self-hosted Root");
        let (leaf, _) = other.leaf("beacon.self-hosted.example");
        let v = verifier(
            other.roots(),
            pin_set(&[HOST], &[&official.spki_pin], "2999-01-01"),
        );
        assert!(verify(&v, &[leaf], "beacon.self-hosted.example").is_ok());
    }

    #[test]
    fn webpki_failures_still_fail_before_pinning() {
        // An untrusted CA fails normal validation on any host (pinned or not), with the usual rustls error.
        let trusted = TestCa::new("Trusted Root");
        let untrusted = TestCa::new("Untrusted Root");
        let v = verifier(
            trusted.roots(),
            pin_set(&[HOST], &[&untrusted.spki_pin], "2999-01-01"),
        );
        for host in [HOST, "other.example"] {
            let (leaf, _) = untrusted.leaf(host);
            let error = verify(&v, &[leaf], host).unwrap_err();
            assert!(!is_mismatch(&error), "{error}");
        }
        // Name mismatch.
        let (leaf, _) = trusted.leaf("other.example");
        assert!(!is_mismatch(&verify(&v, &[leaf], HOST).unwrap_err()));
    }

    #[test]
    fn ip_addresses_are_not_pinned() {
        let ca = TestCa::new("Test Root");
        let mut params = CertificateParams::new(vec!["127.0.0.1".to_string()]).unwrap();
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let key = KeyPair::generate().unwrap();
        let leaf = params.signed_by(&key, &ca.issuer).unwrap().der().clone();
        let v = verifier(ca.roots(), pin_set(&[HOST], &[], "2999-01-01"));
        let ip = ServerName::try_from("127.0.0.1").unwrap();
        assert!(v.verify_server_cert(&leaf, &[], &ip, &[], now()).is_ok());
    }

    #[test]
    fn shipped_config_builds_and_delegates_schemes() {
        let _ = shipped_client_config();
        let ca = TestCa::new("Test Root");
        let v = verifier(ca.roots(), pin_set(&[HOST], &[], "2999-01-01"));
        assert!(!v.supported_verify_schemes().is_empty());
        assert!(!shipped_roots().is_empty());
    }
}
