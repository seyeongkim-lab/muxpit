use std::env;
#[cfg(windows)]
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};

mod hooks;

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
        "hooks" => {
            if let Err(e) = hooks::handle_hooks_command(&args[1..]) {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        "notify" => match parse_notify_args(&args[1..]) {
            Ok(params) => send_request("notify", params),
            Err(e) => {
                eprintln!("Error: {e}");
                eprintln!("Run 'wmux help' for usage.");
                std::process::exit(2);
            }
        },
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
    let data = match send_request_value(method, params) {
        Ok(data) => data,
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
    };

    if !data.is_null() {
        println!("{}", serde_json::to_string_pretty(&data).unwrap());
    } else {
        println!("OK");
    }
}

pub(crate) fn send_request_value(
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut stream = match connect_ipc() {
        Ok(s) => s,
        Err(e) => return Err(format!("wmux is not running or IPC is unavailable: {e}")),
    };

    let request = serde_json::json!({
        "method": method,
        "params": params,
    });

    writeln!(stream, "{}", request).map_err(|e| format!("Failed to write to IPC stream: {e}"))?;
    stream
        .flush()
        .map_err(|e| format!("Failed to flush IPC stream: {e}"))?;

    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .map_err(|e| format!("Failed to read response: {e}"))?;

    let resp: serde_json::Value =
        serde_json::from_str(&response).unwrap_or(serde_json::json!({"error": "Invalid response"}));

    if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        if let Some(data) = resp.get("data") {
            Ok(data.clone())
        } else {
            Ok(serde_json::Value::Null)
        }
    } else {
        let err = resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error");
        Err(err.to_string())
    }
}

fn parse_notify_args(args: &[String]) -> Result<serde_json::Value, String> {
    let mut title: Option<String> = None;
    let mut body: Option<String> = None;
    let mut workspace_id: Option<String> = None;
    let mut surface_id: Option<String> = None;
    let mut source: Option<String> = None;
    let mut event: Option<String> = None;
    let mut positional: Vec<String> = Vec::new();
    let mut i = 0;

    while i < args.len() {
        let arg = &args[i];

        if arg == "--" {
            positional.extend(args[i + 1..].iter().cloned());
            break;
        }

        if let Some((flag, value)) = arg.split_once('=') {
            match flag {
                "--title" => title = Some(value.to_string()),
                "--body" => body = Some(value.to_string()),
                "--workspace" | "--workspace-id" => workspace_id = Some(value.to_string()),
                "--surface" | "--surface-id" => surface_id = Some(value.to_string()),
                "--source" => source = Some(value.to_string()),
                "--event" => event = Some(value.to_string()),
                _ if flag.starts_with("--") => {
                    return Err(format!("Unknown notify option: {flag}"));
                }
                _ => positional.push(arg.clone()),
            }
            i += 1;
            continue;
        }

        match arg.as_str() {
            "--title" => title = Some(take_option_value(args, &mut i, "--title")?),
            "--body" => body = Some(take_option_value(args, &mut i, "--body")?),
            "--workspace" | "--workspace-id" => {
                workspace_id = Some(take_option_value(args, &mut i, arg)?)
            }
            "--surface" | "--surface-id" => {
                surface_id = Some(take_option_value(args, &mut i, arg)?)
            }
            "--source" => source = Some(take_option_value(args, &mut i, "--source")?),
            "--event" => event = Some(take_option_value(args, &mut i, "--event")?),
            _ if arg.starts_with("--") => {
                return Err(format!("Unknown notify option: {arg}"));
            }
            _ => positional.push(arg.clone()),
        }

        i += 1;
    }

    let title = title
        .or_else(|| positional.first().cloned())
        .unwrap_or_else(|| "wmux".to_string());
    let body = body
        .or_else(|| {
            if positional.len() > 1 {
                Some(positional[1..].join(" "))
            } else {
                None
            }
        })
        .unwrap_or_default();

    let mut params = serde_json::Map::new();
    params.insert("title".to_string(), serde_json::json!(title));
    params.insert("body".to_string(), serde_json::json!(body));
    insert_optional(&mut params, "workspace_id", workspace_id);
    insert_optional(&mut params, "surface_id", surface_id);
    insert_optional(&mut params, "source", source);
    insert_optional(&mut params, "event", event);

    Ok(serde_json::Value::Object(params))
}

fn take_option_value(args: &[String], index: &mut usize, flag: &str) -> Result<String, String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .filter(|value| !value.starts_with("--"))
        .ok_or_else(|| format!("Missing value for {flag}"))
}

fn insert_optional(
    map: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: Option<String>,
) {
    if let Some(value) = value {
        if !value.is_empty() {
            map.insert(key.to_string(), serde_json::json!(value));
        }
    }
}

fn print_help() {
    println!(
        r#"wmux - terminal multiplexer CLI

Usage: wmux <command> [args...]

Commands:
  ping                    Check if wmux is running
  notify [options] [title] [body]
                          Send a notification to wmux
  hooks <setup|uninstall|agent>
                          Install or run agent notification hooks
  list-workspaces, ls     List active workspaces
  help                    Show this help message

Notify options:
  --title <title>          Notification title
  --body <body>            Notification body
  --workspace <id>         Workspace id for routing
  --surface <id>           Surface/pane id for routing
  --source <name>          Event source, e.g. codex
  --event <name>           Event name, e.g. stop

Examples:
  wmux ping
  wmux notify "Build done" "All tests passed"
  wmux notify --workspace "$WMUX_WORKSPACE_ID" --surface "$WMUX_SURFACE_ID" --source codex --event stop --title Codex --body "Prompt completed"
  wmux hooks setup codex --yes
  wmux hooks setup claude --yes
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
