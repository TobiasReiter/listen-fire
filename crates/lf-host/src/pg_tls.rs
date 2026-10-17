//! TLS for the Postgres store: rustls on the bundled web root set (or the
//! PEM file `sslrootcert` names), so the binary still needs no system
//! library. The URL's `sslmode` keeps its libpq meaning:
//!
//!   (none)       TLS when the server offers it, its certificate verified
//!   disable      no TLS
//!   prefer       as no sslmode
//!   require      TLS, its certificate not verified (libpq's `require`)
//!   verify-ca    TLS, the certificate's chain verified, not its host name
//!   verify-full  TLS, the chain and the host name verified
//!
//! So lf verifies by default; only an explicit `require` encrypts without
//! checking whom it talks to, as every other Postgres client does.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, RootCertStore, SignatureScheme};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_postgres::config::SslMode;
use tokio_postgres::tls::{ChannelBinding, MakeTlsConnect, TlsConnect};

/// How much of the server's certificate is checked.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Verify {
    Nothing,
    Chain,
    Full,
}

/// A connection URL read for lf: the config tokio-postgres connects with,
/// and the connector its `sslmode` asks for.
pub fn config_of(url: &str) -> Result<(tokio_postgres::Config, RustlsConnect), String> {
    let mut parsed = url::Url::parse(url).map_err(|e| format!("not a Postgres URL: {e}"))?;
    let (mut mode, mut root_cert) = (None, None);
    let kept: Vec<(String, String)> = parsed
        .query_pairs()
        .filter_map(|(k, v)| match k.as_ref() {
            "sslmode" => {
                mode = Some(v.into_owned());
                None
            }
            "sslrootcert" => {
                root_cert = Some(v.into_owned());
                None
            }
            _ => Some((k.into_owned(), v.into_owned())),
        })
        .collect();
    if kept.is_empty() {
        parsed.set_query(None);
    } else {
        parsed.query_pairs_mut().clear().extend_pairs(kept);
    }
    let (ssl_mode, verify) = match mode.as_deref() {
        None | Some("prefer") => (SslMode::Prefer, Verify::Full),
        Some("disable") => (SslMode::Disable, Verify::Full),
        Some("require") => (SslMode::Require, Verify::Nothing),
        Some("verify-ca") => (SslMode::Require, Verify::Chain),
        Some("verify-full") => (SslMode::Require, Verify::Full),
        Some(other) => return Err(format!("sslmode={other}: expected disable, prefer, require, verify-ca or verify-full")),
    };
    let mut config: tokio_postgres::Config = parsed.as_str().parse().map_err(|e| format!("not a Postgres URL: {e}"))?;
    config.ssl_mode(ssl_mode);
    let roots = match root_cert {
        None => RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() },
        Some(path) => roots_from_pem(&path)?,
    };
    Ok((config, RustlsConnect { config: Arc::new(client_config(roots, verify)?) }))
}

/// Every certificate in a PEM file, as the trust anchors.
fn roots_from_pem(path: &str) -> Result<RootCertStore, String> {
    use base64::Engine as _;
    let text = std::fs::read_to_string(path).map_err(|e| format!("sslrootcert {path}: {e}"))?;
    let mut roots = RootCertStore::empty();
    for block in text.split("-----BEGIN CERTIFICATE-----").skip(1) {
        let body = block.split("-----END CERTIFICATE-----").next().unwrap_or_default();
        let der: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        let der = base64::engine::general_purpose::STANDARD.decode(der).map_err(|e| format!("sslrootcert {path}: {e}"))?;
        roots.add(CertificateDer::from(der)).map_err(|e| format!("sslrootcert {path}: {e}"))?;
    }
    if roots.is_empty() {
        return Err(format!("sslrootcert {path}: no certificate in it"));
    }
    Ok(roots)
}

fn client_config(roots: RootCertStore, verify: Verify) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().map_err(|e| e.to_string())?;
    let webpki = rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider).build().map_err(|e| e.to_string())?;
    let verifier: Arc<dyn ServerCertVerifier> = Arc::new(Checked { webpki, verify });
    Ok(builder.dangerous().with_custom_certificate_verifier(verifier).with_no_client_auth())
}

/// The web PKI's verdict, read as far as the sslmode asks.
#[derive(Debug)]
struct Checked {
    webpki: Arc<rustls::client::WebPkiServerVerifier>,
    verify: Verify,
}

impl ServerCertVerifier for Checked {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match (self.verify, self.webpki.verify_server_cert(end_entity, intermediates, server_name, ocsp, now)) {
            (Verify::Nothing, _) => Ok(ServerCertVerified::assertion()),
            (_, Ok(verified)) => Ok(verified),
            (Verify::Chain, Err(rustls::Error::InvalidCertificate(CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. }))) => {
                Ok(ServerCertVerified::assertion())
            }
            (_, Err(error)) => Err(error),
        }
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.webpki.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.webpki.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.webpki.supported_verify_schemes()
    }
}

/// tokio-postgres's TLS hook over tokio-rustls.
#[derive(Clone)]
pub struct RustlsConnect {
    config: Arc<rustls::ClientConfig>,
}

impl<S> MakeTlsConnect<S> for RustlsConnect
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    type Stream = RustlsStream<S>;
    type TlsConnect = RustlsConnectOne;
    type Error = io::Error;

    fn make_tls_connect(&mut self, domain: &str) -> io::Result<RustlsConnectOne> {
        let name = ServerName::try_from(domain.to_string()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        Ok(RustlsConnectOne { connector: tokio_rustls::TlsConnector::from(self.config.clone()), name })
    }
}

pub struct RustlsConnectOne {
    connector: tokio_rustls::TlsConnector,
    name: ServerName<'static>,
}

impl<S> TlsConnect<S> for RustlsConnectOne
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    type Stream = RustlsStream<S>;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = io::Result<RustlsStream<S>>> + Send>>;

    fn connect(self, stream: S) -> Self::Future {
        Box::pin(async move { self.connector.connect(self.name, stream).await.map(RustlsStream) })
    }
}

pub struct RustlsStream<S>(tokio_rustls::client::TlsStream<S>);

impl<S: AsyncRead + AsyncWrite + Unpin> tokio_postgres::tls::TlsStream for RustlsStream<S> {
    fn channel_binding(&self) -> ChannelBinding {
        ChannelBinding::none()
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for RustlsStream<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for RustlsStream<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sslmode_keeps_its_libpq_meaning_and_lf_verifies_by_default() {
        let mode = |url: &str| config_of(url).map(|(c, _)| c.get_ssl_mode());
        assert_eq!(mode("postgres://h/db").unwrap(), SslMode::Prefer);
        assert_eq!(mode("postgres://h/db?sslmode=disable").unwrap(), SslMode::Disable);
        assert_eq!(mode("postgres://h/db?sslmode=verify-full&application_name=lf").unwrap(), SslMode::Require);
        assert_eq!(mode("postgres://h/db?sslmode=verify-ca").unwrap(), SslMode::Require);
        assert!(mode("postgres://h/db?sslmode=allow").unwrap_err().contains("sslmode=allow"));
        assert!(config_of("postgres://h/db?sslrootcert=/no/such/file.pem").err().unwrap().contains("sslrootcert"));
        let (config, _) = config_of("postgres://u@h:5433/db?sslmode=require&application_name=lf").unwrap();
        assert_eq!((config.get_user(), config.get_dbname(), config.get_application_name()), (Some("u"), Some("db"), Some("lf")));
    }
}
