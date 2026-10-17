//! The document store's local backend: the project's `.lf/files/` folder
//! (@lf/local-files, the files slot's module). A stored
//! document's handle is `lf-files:<key>`, its key the path under
//! `.lf/files/`. Exposing a file (for an external that fetches it across the
//! JSON wire) copies it under `exposed/` and serves it at `/files/<id>`:
//! from `lf serve`'s own listener while it serves, else from a loopback
//! listener of its own that lives as long as the process. The local
//! stand-in for the hosted API's short-lived blob route.

use std::cell::OnceCell;
use std::path::{Path, PathBuf};

use tokio::net::TcpListener;

use crate::http::Response;

use crate::json::{Js, Obj};
use crate::obj;

const HANDLE_PREFIX: &str = "lf-files:";
const EXPOSED: &str = "exposed";

/// `teamDocumentKeyPrefix`.
fn team_prefix(tenant: &str) -> String {
    format!("movement-files/{tenant}")
}

pub struct Documents {
    root: PathBuf,
    /// The port exposed files are fetched from: `lf serve`'s, or this
    /// store's own listener's once something was exposed.
    serving: OnceCell<u16>,
}

impl Documents {
    pub fn new(lf_dir: &Path) -> Documents {
        Documents { root: lf_dir.join("files"), serving: OnceCell::new() }
    }

    fn write(&self, key: &str, bytes: &[u8]) -> Result<(), String> {
        let path = self.root.join(key);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))
    }

    /// `put`: store the bytes; the stored file's descriptor
    /// (`documentStoreFileRef`).
    pub fn put(&self, tenant: &str, bytes: &[u8], name: &str, content_type: &str) -> Result<Obj, String> {
        let key = format!("{}/{}/{name}", team_prefix(tenant), uuid::Uuid::new_v4());
        self.write(&key, bytes)?;
        Ok(obj! {
            "__brand" => Js::str("FileRef"),
            "name" => Js::str(name),
            "contentType" => Js::str(content_type),
            "size" => Js::Num(bytes.len().into()),
            "source" => Js::Obj(obj! { "store" => Js::str("document"), "objectUri" => Js::str(format!("{HANDLE_PREFIX}{key}")) }),
        })
    }

    /// `owns`: the handle names one of the tenant's stored documents.
    pub fn owns(&self, object_uri: &str, tenant: &str) -> bool {
        key_of(object_uri).is_some_and(|key| key.starts_with(&format!("{}/", team_prefix(tenant))) && self.root.join(key).exists())
    }

    /// `open`: a stored document's bytes.
    pub fn open(&self, object_uri: &str) -> Result<Vec<u8>, String> {
        let path = key_of(object_uri).map(|key| self.root.join(key)).filter(|p| p.exists());
        let Some(path) = path else { return Err(format!("no stored document {object_uri} in {}", self.root.display())) };
        std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))
    }

    /// Expose files from the listener on `port` (`lf serve`'s), which answers
    /// `/files/<id>` from `exposed`.
    pub fn serve_at(&self, port: u16) {
        let _ = self.serving.set(port);
    }

    /// An exposed file's bytes, by the id its URL names.
    pub fn exposed(&self, id: &str) -> Option<Vec<u8>> {
        exposed_file(&self.root.join(EXPOSED), id)
    }

    /// `expose`: the bytes at a URL an external can fetch.
    pub async fn expose(&self, bytes: &[u8]) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.write(&format!("{EXPOSED}/{id}"), bytes)?;
        let port = match self.serving.get() {
            Some(port) => *port,
            None => {
                let port = self.listen().await?;
                let _ = self.serving.set(port);
                port
            }
        };
        Ok(format!("http://127.0.0.1:{port}/files/{id}"))
    }

    async fn listen(&self) -> Result<u16, String> {
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("the file listener: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let exposed = self.root.join(EXPOSED);
        tokio::task::spawn_local(crate::http::serve(listener, 0, move |request| {
            let found = match request.path.strip_prefix("/files/") {
                Some(id) if request.method == "GET" => exposed_file(&exposed, id),
                _ => None,
            };
            async move {
                match found {
                    Some(bytes) => Response::bytes(200, bytes),
                    None => Response::bytes(404, Vec::new()),
                }
            }
        }));
        Ok(port)
    }
}

/// The exposed file an id names: a uuid's characters only, never a path.
fn exposed_file(exposed: &Path, id: &str) -> Option<Vec<u8>> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return None;
    }
    std::fs::read(exposed.join(id)).ok()
}

/// The key a handle names: `/`-separated names, never a way out of the folder.
fn key_of(object_uri: &str) -> Option<&str> {
    let key = object_uri.strip_prefix(HANDLE_PREFIX)?;
    key.split('/').all(|s| !s.is_empty() && s != "." && s != "..").then_some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_handle_never_names_a_way_out_of_the_folder() {
        assert_eq!(key_of("lf-files:movement-files/local/a/b.txt"), Some("movement-files/local/a/b.txt"));
        assert_eq!(key_of("lf-files:../x"), None);
        assert_eq!(key_of("lf-files:a//b"), None);
        assert_eq!(key_of("s3://x"), None);
    }

    #[test]
    fn a_stored_document_is_the_tenants_and_reads_back() {
        let dir = std::env::temp_dir().join(format!("lf-docs-{}", uuid::Uuid::new_v4()));
        let documents = Documents::new(&dir);
        let file = documents.put("local", b"hello", "a.txt", "text/plain").unwrap();
        let uri = file["source"].get("objectUri").and_then(Js::as_str).unwrap().to_string();
        assert!(documents.owns(&uri, "local"));
        assert!(!documents.owns(&uri, "other"));
        assert_eq!(documents.open(&uri).unwrap(), b"hello");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
