use crate::arguments::{insert_optional, take_option_value};
use serde_json::{Map, Value};
use std::env;

pub(crate) struct ControlContext {
    origin_workspace_id: Option<String>,
    origin_surface_id: Option<String>,
    control_token: Option<String>,
}

pub(crate) struct ControlRequest {
    pub(crate) method: String,
    pub(crate) params: Value,
}

impl ControlContext {
    pub(crate) fn from_env() -> Self {
        Self {
            origin_workspace_id: non_empty_env("WMUX_WORKSPACE_ID"),
            origin_surface_id: non_empty_env("WMUX_SURFACE_ID"),
            control_token: non_empty_env("WMUX_CONTROL_TOKEN"),
        }
    }
}

pub(crate) fn is_control_command(command: &str) -> bool {
    matches!(
        command,
        "identify"
            | "list-surfaces"
            | "list-panes"
            | "split"
            | "subagent"
            | "browser"
            | "focus"
            | "send-text"
            | "read-screen"
    )
}

pub(crate) fn parse_control_request(
    command: &str,
    args: &[String],
    context: ControlContext,
) -> Result<ControlRequest, String> {
    let origin_workspace_id = required_context(context.origin_workspace_id, "WMUX_WORKSPACE_ID")?;
    let origin_surface_id = required_context(context.origin_surface_id, "WMUX_SURFACE_ID")?;
    let control_token = required_context(context.control_token, "WMUX_CONTROL_TOKEN")?;
    let (method, args) = match command {
        "list-panes" => ("list-surfaces", args),
        "subagent" => ("spawn-subagent", args),
        "browser" => {
            let action = args.first().map(String::as_str).unwrap_or("");
            let method =
                match action {
                    "open" => "browser-open",
                    "navigate" => "browser-navigate",
                    "reload" => "browser-reload",
                    "url" => "browser-url",
                    "snapshot" => "browser-snapshot",
                    "console" => "browser-console",
                    "screenshot" => "browser-screenshot",
                    _ => return Err(
                        "Usage: wmux-cli browser <open|navigate|reload|url|snapshot|console|screenshot>"
                            .to_string(),
                    ),
                };
            (method, &args[1..])
        }
        _ => (command, args),
    };

    let mut params = Map::new();
    params.insert(
        "origin_workspace_id".to_string(),
        Value::String(origin_workspace_id.clone()),
    );
    params.insert(
        "origin_surface_id".to_string(),
        Value::String(origin_surface_id.clone()),
    );
    params.insert("control_token".to_string(), Value::String(control_token));

    let mut workspace_id = Some(origin_workspace_id);
    let mut surface_id = Some(origin_surface_id.clone());
    let mut direction = "vertical".to_string();
    let mut split_command = None;
    let mut label = None;
    let mut append_enter = false;
    let mut rows = 24_u64;
    let mut positional = Vec::new();
    let mut i = 0;

    while i < args.len() {
        match args[i].as_str() {
            "--workspace" | "--workspace-id" => {
                workspace_id = Some(take_option_value(args, &mut i, "--workspace")?);
            }
            "--surface" | "--surface-id" | "--pane" => {
                surface_id = Some(take_option_value(args, &mut i, "--surface")?);
            }
            "--direction" if method == "split" || method == "spawn-subagent" => {
                direction = take_option_value(args, &mut i, "--direction")?;
                if direction != "horizontal" && direction != "vertical" {
                    return Err("Direction must be horizontal or vertical".to_string());
                }
            }
            "--command" if method == "split" || method == "spawn-subagent" => {
                split_command = Some(take_option_value(args, &mut i, "--command")?);
            }
            "--label" if method == "spawn-subagent" => {
                label = Some(take_option_value(args, &mut i, "--label")?);
            }
            "--enter" if method == "send-text" => append_enter = true,
            "--rows" if method == "read-screen" => {
                let value = take_option_value(args, &mut i, "--rows")?;
                rows = value
                    .parse::<u64>()
                    .ok()
                    .filter(|value| (1..=500).contains(value))
                    .ok_or_else(|| "Rows must be between 1 and 500".to_string())?;
            }
            "--" => {
                positional.extend(args[i + 1..].iter().cloned());
                break;
            }
            value if value.starts_with("--") => {
                return Err(format!("Unknown {command} option: {value}"));
            }
            value => positional.push(value.to_string()),
        }
        i += 1;
    }

    insert_optional(&mut params, "workspace_id", workspace_id);
    insert_optional(&mut params, "surface_id", surface_id);
    match method {
        "identify" => {
            if !positional.is_empty() {
                return Err("identify does not accept positional arguments".to_string());
            }
        }
        "list-surfaces" | "focus" => {
            if !positional.is_empty() {
                return Err(format!("{command} does not accept positional arguments"));
            }
        }
        "split" => {
            if !positional.is_empty() {
                return Err("Use --command to set a split command".to_string());
            }
            params.insert("direction".to_string(), Value::String(direction));
            insert_optional(&mut params, "command", split_command);
        }
        "spawn-subagent" => {
            if positional.as_slice() != ["spawn"] {
                return Err("Usage: wmux-cli subagent spawn --command <command>".to_string());
            }
            let command = split_command
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "subagent spawn requires --command".to_string())?;
            params.insert("direction".to_string(), Value::String(direction));
            params.insert("command".to_string(), Value::String(command));
            params.insert(
                "parent_surface_id".to_string(),
                Value::String(origin_surface_id.clone()),
            );
            insert_optional(&mut params, "label", label);
        }
        "send-text" => {
            if positional.is_empty() {
                return Err("send-text requires text".to_string());
            }
            let mut text = positional.join(" ");
            if append_enter {
                text.push('\r');
            }
            params.insert("text".to_string(), Value::String(text));
        }
        "read-screen" => {
            if !positional.is_empty() {
                return Err("read-screen does not accept positional arguments".to_string());
            }
            params.insert("rows".to_string(), Value::Number(rows.into()));
        }
        "browser-open" | "browser-navigate" => {
            if positional.len() != 1 {
                return Err("Usage: wmux-cli browser <open|navigate> <url>".to_string());
            }
            params.insert("url".to_string(), Value::String(positional.remove(0)));
        }
        "browser-reload" | "browser-url" | "browser-snapshot" | "browser-console"
        | "browser-screenshot" => {
            if !positional.is_empty() {
                return Err(format!("{command} does not accept positional arguments"));
            }
        }
        _ => return Err(format!("Unknown control command: {command}")),
    }

    Ok(ControlRequest {
        method: method.to_string(),
        params: Value::Object(params),
    })
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}

fn required_context(value: Option<String>, name: &str) -> Result<String, String> {
    value.ok_or_else(|| format!("{name} is missing; run this command inside a wmux terminal"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> ControlContext {
        ControlContext {
            origin_workspace_id: Some("ws-1".to_string()),
            origin_surface_id: Some("pane-1".to_string()),
            control_token: Some("secret".to_string()),
        }
    }

    #[test]
    fn identify_includes_origin_context() {
        let request = parse_control_request("identify", &[], context()).unwrap();

        assert_eq!(request.method, "identify");
        assert_eq!(request.params["origin_workspace_id"], "ws-1");
        assert_eq!(request.params["origin_surface_id"], "pane-1");
        assert_eq!(request.params["control_token"], "secret");
    }

    #[test]
    fn split_defaults_to_origin_and_accepts_command() {
        let args = vec![
            "--direction".to_string(),
            "horizontal".to_string(),
            "--command".to_string(),
            "codex".to_string(),
        ];
        let request = parse_control_request("split", &args, context()).unwrap();

        assert_eq!(request.params["workspace_id"], "ws-1");
        assert_eq!(request.params["surface_id"], "pane-1");
        assert_eq!(request.params["direction"], "horizontal");
        assert_eq!(request.params["command"], "codex");
    }

    #[test]
    fn send_text_appends_carriage_return_only_with_enter() {
        let args = vec!["--enter".to_string(), "npm".to_string(), "test".to_string()];
        let request = parse_control_request("send-text", &args, context()).unwrap();

        assert_eq!(request.params["text"], "npm test\r");
    }

    #[test]
    fn read_screen_rejects_zero_rows() {
        let args = vec!["--rows".to_string(), "0".to_string()];

        assert!(parse_control_request("read-screen", &args, context()).is_err());
    }

    #[test]
    fn subagent_spawn_includes_parent_and_label() {
        let args = vec![
            "spawn".to_string(),
            "--command".to_string(),
            "codex".to_string(),
            "--label".to_string(),
            "reviewer".to_string(),
        ];
        let request = parse_control_request("subagent", &args, context()).unwrap();

        assert_eq!(request.method, "spawn-subagent");
        assert_eq!(request.params["parent_surface_id"], "pane-1");
        assert_eq!(request.params["command"], "codex");
        assert_eq!(request.params["label"], "reviewer");
    }

    #[test]
    fn browser_navigate_uses_workspace_context() {
        let args = vec![
            "navigate".to_string(),
            "https://example.com/docs".to_string(),
        ];
        let request = parse_control_request("browser", &args, context()).unwrap();

        assert_eq!(request.method, "browser-navigate");
        assert_eq!(request.params["workspace_id"], "ws-1");
        assert_eq!(request.params["surface_id"], "pane-1");
        assert_eq!(request.params["url"], "https://example.com/docs");
    }

    #[test]
    fn browser_open_uses_workspace_context() {
        let args = vec!["open".to_string(), "https://example.com".to_string()];
        let request = parse_control_request("browser", &args, context()).unwrap();

        assert_eq!(request.method, "browser-open");
        assert_eq!(request.params["workspace_id"], "ws-1");
        assert_eq!(request.params["surface_id"], "pane-1");
        assert_eq!(request.params["url"], "https://example.com");
    }

    #[test]
    fn browser_snapshot_maps_to_control_method() {
        let request =
            parse_control_request("browser", &["snapshot".to_string()], context()).unwrap();

        assert_eq!(request.method, "browser-snapshot");
    }

    #[test]
    fn browser_rejects_unknown_action() {
        let request =
            parse_control_request("browser", &["execute-javascript".to_string()], context());

        assert!(request.is_err());
    }
}
