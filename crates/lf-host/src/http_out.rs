//! One HTTP request out, over plain HTTP or HTTPS: what the host sends a
//! provider's token endpoint (a refresh, a code exchange). TLS is rustls on
//! the bundled web root set, so the binary needs no system library.

use std::sync::{Arc, OnceLock};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;

pub struct Answer {
    pub status: u16,
    pub body: String,
}

/// POST `body` to `url` with `headers`; the answer whatever its status.
pub async fn post(url: &str, headers: &[(String, String)], body: String) -> Result<Answer, String> {
    let target = url::Url::parse(url).map_err(|e| format!("{url}: {e}"))?;
    let host = target.host_str().ok_or_else(|| format!("{url}: no host"))?.trim_start_matches('[').trim_end_matches(']').to_string();
    let port = target.port_or_known_default().ok_or_else(|| format!("{url}: no port"))?;
    let path = match target.query() {
        Some(query) => format!("{}?{query}", target.path()),
        None => target.path().to_string(),
    };
    let authority = match target.port() {
        Some(port) => format!("{}:{port}", target.host_str().unwrap_or_default()),
        None => target.host_str().unwrap_or_default().to_string(),
    };
    let mut request = Request::post(path).header("host", authority);
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let request = request.body(Full::new(Bytes::from(body))).map_err(|e| e.to_string())?;
    let stream = TcpStream::connect((host.as_str(), port)).await.map_err(|e| format!("{url}: {e}"))?;
    match target.scheme() {
        "http" => exchange(stream, request).await,
        "https" => {
            let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| format!("{url}: {e}"))?;
            let tls = tls_connector().connect(name, stream).await.map_err(|e| format!("{url}: {e}"))?;
            exchange(tls, request).await
        }
        other => Err(format!("{url}: {other} is not http(s)")),
    }
    .map_err(|e| format!("{url}: {e}"))
}

async fn exchange<S>(stream: S, request: Request<Full<Bytes>>) -> Result<Answer, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let response = sender.send_request(request).await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
    Ok(Answer { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

fn tls_connector() -> tokio_rustls::TlsConnector {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    let config = CONFIG.get_or_init(|| {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("rustls supports its default protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        Arc::new(config)
    });
    tokio_rustls::TlsConnector::from(config.clone())
}

// ── Encodings the token calls use ───────────────────────────────────────────

/// `application/x-www-form-urlencoded`, as `URLSearchParams` writes it.
pub fn form(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish()
}

/// `encodeURIComponent`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        let keep = byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte);
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

const STANDARD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Base64, padded (`Buffer.toString('base64')`).
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(STANDARD[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Base64url, unpadded (`Buffer.toString('base64url')`).
pub fn base64url(bytes: &[u8]) -> String {
    base64(bytes).trim_end_matches('=').replace('+', "-").replace('/', "_")
}

/// `n` random bytes from the operating system.
pub fn random_bytes(n: usize) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).map_err(|e| format!("no random bytes from the operating system: {e}"))?;
    Ok(bytes)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodings_match_node() {
        assert_eq!(base64(b"cid:csecret"), "Y2lkOmNzZWNyZXQ=");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(encode_uri_component("a b/c:d"), "a%20b%2Fc%3Ad");
        assert_eq!(form(&[("grant_type", "refresh_token"), ("scope", "a b"), ("x", "é")]), "grant_type=refresh_token&scope=a+b&x=%C3%A9");
    }
}
