//! wmux-server: serve the wmux web frontend + a WebSocket/HTTP bridge to a
//! local engine, so a browser on another machine can drive this host.
//!
//! Phase 1 (this file): static serving, `readDir` over WS, file/dir download.
//! Phase 2 will fill in the pty message variants by reusing `wmux-core`.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get},
    Router,
};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Write as _,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};
use tower_http::services::ServeDir;

#[derive(Parser)]
#[command(name = "wmux-server")]
struct Args {
    /// Address to bind, e.g. 100.64.0.3:8787. Do NOT bind to a public address.
    #[arg(long, default_value = "127.0.0.1:8787")]
    bind: String,
    /// Shared secret. Required on /ws and /download as ?token=.
    #[arg(long)]
    token: String,
    /// Directory of built frontend assets to serve (vite `dist/`).
    #[arg(long = "static", default_value = "./dist")]
    static_dir: PathBuf,
    /// Filesystem root that readDir/download are confined to. Defaults to $HOME.
    #[arg(long)]
    root: Option<PathBuf>,
}

#[derive(Clone)]
struct AppState {
    token: Arc<String>,
    root: Arc<PathBuf>,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    let root_arg = args.root.unwrap_or_else(default_root);
    let root = std::fs::canonicalize(&root_arg)
        .unwrap_or_else(|e| panic!("--root {:?} is not accessible: {e}", root_arg));
    let root_display = root.display().to_string();

    let state = AppState {
        token: Arc::new(args.token),
        root: Arc::new(root),
    };

    let app = Router::new()
        .route("/ws", any(ws_handler))
        .route("/download", get(download))
        .fallback_service(ServeDir::new(&args.static_dir).append_index_html_on_directories(true))
        .with_state(state);

    let addr: SocketAddr = args.bind.parse().expect("--bind must be host:port");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {addr}: {e}"));
    eprintln!("wmux-server listening on http://{addr}  (root={root_display})");
    axum::serve(listener, app).await.expect("server error");
}

fn default_root() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn token_ok(q: &HashMap<String, String>, st: &AppState) -> bool {
    q.get("token").map(String::as_str) == Some(st.token.as_str())
}

/// Resolve a client-supplied path and confine it to `root`. Empty -> root.
fn resolve_in_root(root: &Path, p: &str) -> Result<PathBuf, String> {
    let candidate = if p.is_empty() {
        root.to_path_buf()
    } else {
        let pb = PathBuf::from(p);
        if pb.is_absolute() {
            pb
        } else {
            root.join(pb)
        }
    };
    let canon = std::fs::canonicalize(&candidate).map_err(|e| format!("{p}: {e}"))?;
    if !canon.starts_with(root) {
        return Err(format!("{p}: outside root"));
    }
    Ok(canon)
}

// ---- WebSocket protocol -----------------------------------------------------

#[derive(Deserialize)]
#[allow(dead_code)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ClientMsg {
    Spawn {
        id: i64,
        rows: u16,
        cols: u16,
        command: Option<String>,
        cwd: Option<String>,
    },
    Write {
        id: i64,
        data: String,
    },
    Resize {
        id: i64,
        rows: u16,
        cols: u16,
    },
    Kill {
        id: i64,
    },
    ReadDir {
        req_id: i64,
        path: String,
    },
}

#[derive(Serialize)]
#[allow(dead_code)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ServerMsg {
    Spawned {
        id: i64,
        pty_id: u32,
    },
    Output {
        pty_id: u32,
        data: String,
    },
    Exit {
        pty_id: u32,
        code: Option<i32>,
    },
    Dir {
        req_id: i64,
        path: String,
        entries: Vec<DirEntry>,
    },
    Error {
        req_id: Option<i64>,
        message: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    is_dir: bool,
    size: u64,
    mtime: Option<u64>,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<HashMap<String, String>>,
    State(st): State<AppState>,
) -> Response {
    if !token_ok(&q, &st) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, st))
}

async fn handle_socket(mut socket: WebSocket, st: AppState) {
    while let Some(Ok(msg)) = socket.recv().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let reply = match serde_json::from_str::<ClientMsg>(&text) {
            Ok(ClientMsg::ReadDir { req_id, path }) => read_dir_reply(&st.root, req_id, &path),
            Ok(ClientMsg::Spawn { .. })
            | Ok(ClientMsg::Write { .. })
            | Ok(ClientMsg::Resize { .. })
            | Ok(ClientMsg::Kill { .. }) => ServerMsg::Error {
                req_id: None,
                message: "pty not implemented yet (Phase 2)".into(),
            },
            Err(e) => ServerMsg::Error {
                req_id: None,
                message: format!("bad message: {e}"),
            },
        };
        let json = serde_json::to_string(&reply).unwrap_or_else(|_| "{}".into());
        if socket.send(Message::Text(json.into())).await.is_err() {
            break;
        }
    }
}

fn read_dir_reply(root: &Path, req_id: i64, path: &str) -> ServerMsg {
    let dir = match resolve_in_root(root, path) {
        Ok(d) => d,
        Err(message) => {
            return ServerMsg::Error {
                req_id: Some(req_id),
                message,
            }
        }
    };
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) => {
            return ServerMsg::Error {
                req_id: Some(req_id),
                message: format!("{e}"),
            }
        }
    };
    let mut entries: Vec<DirEntry> = read
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let meta = e.metadata().ok()?;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            Some(DirEntry {
                name,
                is_dir: meta.is_dir(),
                size: meta.len(),
                mtime,
            })
        })
        .collect();
    // Directories first, then case-insensitive name.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    ServerMsg::Dir {
        req_id,
        path: dir.to_string_lossy().into_owned(),
        entries,
    }
}

// ---- Download ---------------------------------------------------------------

async fn download(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<AppState>,
) -> Response {
    if !token_ok(&q, &st) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    let path = match q.get("path") {
        Some(p) => p.clone(),
        None => return (StatusCode::BAD_REQUEST, "missing path").into_response(),
    };
    let root = st.root.clone();

    // std::fs + zip are blocking; keep them off the async runtime.
    let result = tokio::task::spawn_blocking(move || build_download(&root, &path)).await;

    match result {
        Ok(Ok((filename, bytes))) => {
            let disposition = format!("attachment; filename=\"{}\"", sanitize_filename(&filename));
            (
                [
                    (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                    (header::CONTENT_DISPOSITION, disposition),
                ],
                bytes,
            )
                .into_response()
        }
        Ok(Err(msg)) => (StatusCode::FORBIDDEN, msg).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")).into_response(),
    }
}

fn build_download(root: &Path, path: &str) -> Result<(String, Vec<u8>), String> {
    let target = resolve_in_root(root, path)?;
    let meta = std::fs::metadata(&target).map_err(|e| format!("{e}"))?;
    let base = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());

    if meta.is_dir() {
        let bytes = zip_dir(&target)?;
        Ok((format!("{base}.zip"), bytes))
    } else {
        let bytes = std::fs::read(&target).map_err(|e| format!("{e}"))?;
        Ok((base, bytes))
    }
}

fn zip_dir(dir: &Path) -> Result<Vec<u8>, String> {
    use zip::write::SimpleFileOptions;
    let mut cursor = std::io::Cursor::new(Vec::new());
    let mut zw = zip::ZipWriter::new(&mut cursor);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for entry in walkdir::WalkDir::new(dir).into_iter().flatten() {
        let p = entry.path();
        let rel = match p.strip_prefix(dir) {
            Ok(r) if !r.as_os_str().is_empty() => r,
            _ => continue,
        };
        let name = rel.to_string_lossy().replace('\\', "/");
        if entry.file_type().is_dir() {
            zw.add_directory(format!("{name}/"), options)
                .map_err(|e| format!("{e}"))?;
        } else if entry.file_type().is_file() {
            zw.start_file(name, options).map_err(|e| format!("{e}"))?;
            let data = std::fs::read(p).map_err(|e| format!("{e}"))?;
            zw.write_all(&data).map_err(|e| format!("{e}"))?;
        }
    }
    zw.finish().map_err(|e| format!("{e}"))?;
    Ok(cursor.into_inner())
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c == '"' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        let mut dir = std::env::temp_dir();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.push(format!("wmux-server-test-{nonce}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    #[test]
    fn resolve_in_root_accepts_empty_and_relative_paths() {
        let root = temp_root();
        let child = root.join("child");
        std::fs::create_dir_all(&child).unwrap();

        assert_eq!(resolve_in_root(&root, "").unwrap(), root);
        assert_eq!(resolve_in_root(&root, "child").unwrap(), child);
    }

    #[test]
    fn resolve_in_root_rejects_parent_escape() {
        let root = temp_root();
        let outside = root.parent().unwrap().to_path_buf();
        let escaped = root.join("..");

        assert_eq!(
            resolve_in_root(&root, &escaped.to_string_lossy()).unwrap_err(),
            format!("{}: outside root", escaped.to_string_lossy())
        );
        assert_eq!(
            resolve_in_root(&root, &outside.to_string_lossy()).unwrap_err(),
            format!("{}: outside root", outside.to_string_lossy())
        );
    }

    #[test]
    fn sanitize_filename_replaces_header_breaking_chars() {
        assert_eq!(sanitize_filename("a\"b\\c\n"), "a_b_c_");
    }
}
