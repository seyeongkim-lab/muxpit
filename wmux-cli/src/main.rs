use std::env;
#[cfg(windows)]
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};

#[cfg(windows)]
const PIPE_NAME: &str = r"\\.\pipe\wmux";
#[cfg(unix)]
const DEFAULT_SOCKET_PATH: &str = "/tmp/wmux.sock";

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        print_help();
        return;
    }

    match args[0].as_str() {
        "ping" => send_request("ping", serde_json::json!({})),
        "notify" => {
            let title = args.get(1).map(|s| s.as_str()).unwrap_or("wmux");
            let body = args.get(2).map(|s| s.as_str()).unwrap_or("");
            send_request(
                "notify",
                serde_json::json!({ "title": title, "body": body }),
            );
        }
        "list-workspaces" | "ls" => {
            send_request("list-workspaces", serde_json::json!({}));
        }
        "help" | "--help" | "-h" => print_help(),
        other => {
            eprintln!("Unknown command: {other}");
            eprintln!("Run 'wmux help' for usage.");
            std::process::exit(1);
        }
    }
}

fn send_request(method: &str, params: serde_json::Value) {
    let mut stream = match connect_ipc() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Error: wmux is not running or IPC is unavailable: {e}");
            eprintln!("Start the wmux application first.");
            std::process::exit(1);
        }
    };

    let request = serde_json::json!({
        "method": method,
        "params": params,
    });

    writeln!(stream, "{}", request).expect("Failed to write to IPC stream");
    stream.flush().expect("Failed to flush");

    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .expect("Failed to read response");

    let resp: serde_json::Value =
        serde_json::from_str(&response).unwrap_or(serde_json::json!({"error": "Invalid response"}));

    if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        if let Some(data) = resp.get("data") {
            if !data.is_null() {
                println!("{}", serde_json::to_string_pretty(data).unwrap());
            } else {
                println!("OK");
            }
        } else {
            println!("OK");
        }
    } else {
        let err = resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error");
        eprintln!("Error: {err}");
        std::process::exit(1);
    }
}

fn print_help() {
    println!(
        r#"wmux - terminal multiplexer CLI

Usage: wmux <command> [args...]

Commands:
  ping                    Check if wmux is running
  notify <title> [body]   Send a notification to wmux
  list-workspaces, ls     List active workspaces
  help                    Show this help message

Examples:
  wmux ping
  wmux notify "Build done" "All tests passed"
  wmux ls"#
    );
}

#[cfg(windows)]
fn connect_ipc() -> std::io::Result<Box<dyn ReadWrite>> {
    let pipe = OpenOptions::new().read(true).write(true).open(PIPE_NAME)?;
    Ok(Box::new(pipe))
}

#[cfg(unix)]
fn connect_ipc() -> std::io::Result<Box<dyn ReadWrite>> {
    let socket_path =
        env::var("WMUX_SOCKET_PATH").unwrap_or_else(|_| DEFAULT_SOCKET_PATH.to_string());
    let stream = std::os::unix::net::UnixStream::connect(socket_path)?;
    Ok(Box::new(stream))
}
