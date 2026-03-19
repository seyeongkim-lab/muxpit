use std::env;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};

const PIPE_NAME: &str = r"\\.\pipe\wmux";

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
    let pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(PIPE_NAME);

    let mut stream = match pipe {
        Ok(s) => s,
        Err(_) => {
            eprintln!("Error: wmux is not running. Start the wmux application first.");
            std::process::exit(1);
        }
    };

    let request = serde_json::json!({
        "method": method,
        "params": params,
    });

    writeln!(stream, "{}", request).expect("Failed to write to pipe");
    stream.flush().expect("Failed to flush");

    let mut reader = BufReader::new(&stream);
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
        r#"wmux - Windows terminal multiplexer CLI

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
