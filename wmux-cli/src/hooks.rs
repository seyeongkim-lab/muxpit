use crate::platform::{binary_on_path, home_dir, hook_command, replace_file};
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Agent {
    Codex,
    Claude,
}

impl Agent {
    fn all() -> [Agent; 2] {
        [Agent::Codex, Agent::Claude]
    }

    fn parse(raw: &str) -> Option<Agent> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "codex" => Some(Agent::Codex),
            "claude" | "claude-code" | "claudecode" => Some(Agent::Claude),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Agent::Codex => "codex",
            Agent::Claude => "claude",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Agent::Codex => "Codex",
            Agent::Claude => "Claude Code",
        }
    }

    fn binary_name(self) -> &'static str {
        match self {
            Agent::Codex => "codex",
            Agent::Claude => "claude",
        }
    }

    fn config_dir(self) -> Result<PathBuf, String> {
        match self {
            Agent::Codex => env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| home_dir().map(|home| home.join(".codex")))
                .ok_or_else(|| "Could not resolve CODEX_HOME or a home directory".to_string()),
            Agent::Claude => env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| home_dir().map(|home| home.join(".claude")))
                .ok_or_else(|| {
                    "Could not resolve CLAUDE_CONFIG_DIR or a home directory".to_string()
                }),
        }
    }

    fn config_file(self) -> &'static str {
        match self {
            Agent::Codex => "hooks.json",
            Agent::Claude => "settings.json",
        }
    }

    fn disabled_env(self) -> &'static str {
        match self {
            Agent::Codex => "WMUX_CODEX_HOOKS_DISABLED",
            Agent::Claude => "WMUX_CLAUDE_HOOKS_DISABLED",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentHookEvent {
    SessionStart,
    UserPromptSubmit,
    Stop,
    PreToolUse,
    PermissionRequest,
    Notification,
    SessionEnd,
    SubagentStop,
}

impl AgentHookEvent {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "sessionstart" | "session-start" | "session_start" => Some(Self::SessionStart),
            "userpromptsubmit" | "user-prompt-submit" | "user_prompt_submit" => {
                Some(Self::UserPromptSubmit)
            }
            "stop" => Some(Self::Stop),
            "pretooluse" | "pre-tool-use" | "pre_tool_use" => Some(Self::PreToolUse),
            "permissionrequest" | "permission-request" | "permission_request" => {
                Some(Self::PermissionRequest)
            }
            "notification" | "notify" => Some(Self::Notification),
            "sessionend" | "session-end" | "session_end" => Some(Self::SessionEnd),
            "subagentstop" | "subagent-stop" | "subagent_stop" => Some(Self::SubagentStop),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::SessionStart => "SessionStart",
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::Stop => "Stop",
            Self::PreToolUse => "PreToolUse",
            Self::PermissionRequest => "PermissionRequest",
            Self::Notification => "Notification",
            Self::SessionEnd => "SessionEnd",
            Self::SubagentStop => "SubagentStop",
        }
    }
}

const CODEX_HOOK_EVENTS: &[AgentHookEvent] = &[
    AgentHookEvent::SessionStart,
    AgentHookEvent::UserPromptSubmit,
    AgentHookEvent::Stop,
    AgentHookEvent::PreToolUse,
    AgentHookEvent::PermissionRequest,
];

const CLAUDE_HOOK_EVENTS: &[AgentHookEvent] = &[
    AgentHookEvent::SessionStart,
    AgentHookEvent::UserPromptSubmit,
    AgentHookEvent::Stop,
    AgentHookEvent::PreToolUse,
    AgentHookEvent::PermissionRequest,
    AgentHookEvent::Notification,
    AgentHookEvent::SessionEnd,
    AgentHookEvent::SubagentStop,
];

const CLAUDE_INSTALLED_HOOK_EVENTS: &[AgentHookEvent] = &[
    AgentHookEvent::SessionStart,
    AgentHookEvent::UserPromptSubmit,
    AgentHookEvent::Stop,
    AgentHookEvent::PermissionRequest,
    AgentHookEvent::Notification,
    AgentHookEvent::SessionEnd,
];

trait AgentHookAdapter: Sync {
    fn known_events(&self) -> &'static [AgentHookEvent];
    fn installed_events(&self) -> &'static [AgentHookEvent];
    fn install(&self, yes: bool) -> Result<(), String>;
    fn uninstall(&self, yes: bool) -> Result<(), String>;
    fn handle_event(&self, event: AgentHookEvent, payload: &Value) -> HookOutcome;
}

#[derive(Default)]
struct HookOutcome {
    notification: Option<HookNotification>,
}

struct HookNotification {
    title: &'static str,
    body: String,
}

struct CodexHookAdapter;
struct ClaudeHookAdapter;

impl AgentHookAdapter for CodexHookAdapter {
    fn known_events(&self) -> &'static [AgentHookEvent] {
        CODEX_HOOK_EVENTS
    }

    fn installed_events(&self) -> &'static [AgentHookEvent] {
        CODEX_HOOK_EVENTS
    }

    fn install(&self, yes: bool) -> Result<(), String> {
        install_agent_config(Agent::Codex, self.installed_events(), yes)?;
        let config_dir = Agent::Codex.config_dir()?;
        install_codex_hooks_feature(&config_dir.join("config.toml"), yes)
    }

    fn uninstall(&self, yes: bool) -> Result<(), String> {
        uninstall_agent_config(Agent::Codex, yes)?;
        let config_dir = Agent::Codex.config_dir()?;
        uninstall_codex_hooks_feature(&config_dir.join("config.toml"), yes)
    }

    fn handle_event(&self, event: AgentHookEvent, payload: &Value) -> HookOutcome {
        match event {
            AgentHookEvent::Stop => HookOutcome {
                notification: Some(HookNotification {
                    title: "Codex",
                    body: payload_string(payload, &["message", "summary"])
                        .unwrap_or_else(|| "Prompt completed".to_string()),
                }),
            },
            AgentHookEvent::PermissionRequest => HookOutcome {
                notification: Some(HookNotification {
                    title: "Codex",
                    body: payload_string(payload, &["tool_name", "toolName", "command", "message"])
                        .map(|value| format!("Permission requested: {value}"))
                        .unwrap_or_else(|| "Permission requested".to_string()),
                }),
            },
            _ => HookOutcome::default(),
        }
    }
}

impl AgentHookAdapter for ClaudeHookAdapter {
    fn known_events(&self) -> &'static [AgentHookEvent] {
        CLAUDE_HOOK_EVENTS
    }

    fn installed_events(&self) -> &'static [AgentHookEvent] {
        CLAUDE_INSTALLED_HOOK_EVENTS
    }

    fn install(&self, yes: bool) -> Result<(), String> {
        install_agent_config(Agent::Claude, self.installed_events(), yes)?;
        Ok(())
    }

    fn uninstall(&self, yes: bool) -> Result<(), String> {
        uninstall_agent_config(Agent::Claude, yes)
    }

    fn handle_event(&self, event: AgentHookEvent, payload: &Value) -> HookOutcome {
        match event {
            AgentHookEvent::Stop => HookOutcome {
                notification: Some(HookNotification {
                    title: "Claude Code",
                    body: payload_string(payload, &["message", "summary"])
                        .unwrap_or_else(|| "Prompt completed".to_string()),
                }),
            },
            AgentHookEvent::PermissionRequest => HookOutcome {
                notification: Some(HookNotification {
                    title: "Claude Code",
                    body: payload_string(payload, &["tool_name", "toolName", "command", "message"])
                        .map(|value| format!("Permission requested: {value}"))
                        .unwrap_or_else(|| "Permission requested".to_string()),
                }),
            },
            AgentHookEvent::Notification => HookOutcome {
                notification: Some(HookNotification {
                    title: "Claude Code",
                    body: payload_string(payload, &["message", "body", "text"])
                        .unwrap_or_else(|| "Needs attention".to_string()),
                }),
            },
            _ => HookOutcome::default(),
        }
    }
}

static CODEX_ADAPTER: CodexHookAdapter = CodexHookAdapter;
static CLAUDE_ADAPTER: ClaudeHookAdapter = ClaudeHookAdapter;

fn agent_adapter(agent: Agent) -> &'static dyn AgentHookAdapter {
    match agent {
        Agent::Codex => &CODEX_ADAPTER,
        Agent::Claude => &CLAUDE_ADAPTER,
    }
}

pub(crate) fn handle_hooks_command(args: &[String]) -> Result<(), String> {
    if args.is_empty() || matches!(args[0].as_str(), "help" | "--help" | "-h") {
        print_hooks_help();
        return Ok(());
    }

    match args[0].as_str() {
        "setup" | "install" => run_setup_hooks(&args[1..], false),
        "uninstall" => run_setup_hooks(&args[1..], true),
        agent_name => {
            let agent = Agent::parse(agent_name)
                .ok_or_else(|| format!("Unknown hooks target: {agent_name}"))?;
            let action = args
                .get(1)
                .map(String::as_str)
                .ok_or_else(|| "Missing hooks action. Try: install, uninstall, Stop".to_string())?;
            match action {
                "install" => {
                    let options = hooks_options(&args[2..])?;
                    ensure_target_matches(agent, options.agent)?;
                    install_agent(agent, options.yes)
                }
                "uninstall" => {
                    let options = hooks_options(&args[2..])?;
                    ensure_target_matches(agent, options.agent)?;
                    uninstall_agent(agent, options.yes)
                }
                event_name => {
                    let event = AgentHookEvent::parse(event_name)
                        .ok_or_else(|| format!("Unknown hooks action: {event_name}"))?;
                    run_agent_hook(agent, event)
                }
            }
        }
    }
}

fn print_hooks_help() {
    let codex_events = event_names_for_help(agent_adapter(Agent::Codex).known_events());
    let claude_events = event_names_for_help(agent_adapter(Agent::Claude).known_events());
    println!(
        "wmux-cli hooks - install and run agent notification hooks

Usage:
  wmux-cli hooks setup [codex|claude] [--agent <agent>] [--yes|-y]
  wmux-cli hooks uninstall [codex|claude] [--agent <agent>] [--yes|-y]
  wmux-cli hooks <codex|claude> install [--yes|-y]
  wmux-cli hooks <codex|claude> uninstall [--yes|-y]
  wmux-cli hooks <codex|claude> <event>

Codex events:
  {codex_events}

Claude session and notification hooks are installed for supported events.
Known Claude events:
  {claude_events}

Installed hooks no-op unless WMUX_SURFACE_ID is present."
    );
}

fn event_names_for_help(events: &[AgentHookEvent]) -> String {
    events
        .iter()
        .map(|event| event.name())
        .collect::<Vec<_>>()
        .join(", ")
}

#[derive(Default)]
struct HooksOptions {
    agent: Option<Agent>,
    yes: bool,
}

fn hooks_options(args: &[String]) -> Result<HooksOptions, String> {
    let mut options = HooksOptions::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--yes" | "-y" => options.yes = true,
            "--agent" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "Missing value for --agent".to_string())?;
                options.agent = Some(
                    Agent::parse(value).ok_or_else(|| format!("Unknown hooks target: {value}"))?,
                );
            }
            value if !value.starts_with('-') => {
                let agent =
                    Agent::parse(value).ok_or_else(|| format!("Unknown hooks target: {value}"))?;
                if let Some(existing) = options.agent {
                    if existing != agent {
                        return Err(
                            "Conflicting hooks target: use one positional agent or --agent"
                                .to_string(),
                        );
                    }
                }
                options.agent = Some(agent);
            }
            other => return Err(format!("Unknown hooks option: {other}")),
        }
        i += 1;
    }
    Ok(options)
}

fn ensure_target_matches(agent: Agent, option_agent: Option<Agent>) -> Result<(), String> {
    if let Some(option_agent) = option_agent {
        if option_agent != agent {
            return Err(
                "Conflicting hooks target: use one positional agent or --agent".to_string(),
            );
        }
    }
    Ok(())
}

fn run_setup_hooks(args: &[String], uninstall: bool) -> Result<(), String> {
    let options = hooks_options(args)?;
    let agents: Vec<Agent> = match options.agent {
        Some(agent) => vec![agent],
        None => Agent::all().to_vec(),
    };

    let mut changed = 0;
    let mut skipped = 0;
    for agent in agents {
        if !uninstall && options.agent.is_none() && !binary_on_path(agent.binary_name()) {
            println!("{}: skipped (binary not found on PATH)", agent.name());
            skipped += 1;
            continue;
        }

        if uninstall {
            uninstall_agent(agent, options.yes)?;
        } else {
            install_agent(agent, options.yes)?;
        }
        changed += 1;
    }

    println!(
        "Done: {changed} {}, {skipped} skipped",
        if uninstall {
            "uninstalled"
        } else {
            "installed"
        }
    );
    Ok(())
}

fn install_agent(agent: Agent, yes: bool) -> Result<(), String> {
    agent_adapter(agent).install(yes)
}

fn uninstall_agent(agent: Agent, yes: bool) -> Result<(), String> {
    agent_adapter(agent).uninstall(yes)
}

fn install_agent_config(agent: Agent, events: &[AgentHookEvent], yes: bool) -> Result<(), String> {
    let config_dir = agent.config_dir()?;
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Could not create {}: {e}", config_dir.display()))?;
    let config_path = config_dir.join(agent.config_file());
    let mut config = read_json_object(&config_path)?;
    let mut hooks = take_hooks_object(&mut config)?;
    remove_owned_hooks(&mut hooks, agent);

    for event in events {
        insert_hook_group(&mut hooks, agent, *event);
    }
    config.insert("hooks".to_string(), Value::Object(hooks));

    write_json_if_changed(
        &config_path,
        &config,
        yes,
        &format!("{} hooks", agent.display_name()),
    )?;

    Ok(())
}

fn uninstall_agent_config(agent: Agent, yes: bool) -> Result<(), String> {
    let config_dir = agent.config_dir()?;
    let config_path = config_dir.join(agent.config_file());
    if !config_path.exists() {
        println!(
            "No {} found at {}",
            agent.config_file(),
            config_path.display()
        );
        return Ok(());
    }

    let mut config = read_json_object(&config_path)?;
    let mut hooks = take_hooks_object(&mut config)?;
    let removed = remove_owned_hooks(&mut hooks, agent);

    if hooks.is_empty() {
        config.remove("hooks");
    } else {
        config.insert("hooks".to_string(), Value::Object(hooks));
    }

    if removed {
        write_json_if_changed(
            &config_path,
            &config,
            yes,
            &format!("{} hooks", agent.display_name()),
        )?;
    } else {
        println!("Removed 0 wmux hook(s) from {}", config_path.display());
    }

    Ok(())
}

fn run_agent_hook(agent: Agent, event: AgentHookEvent) -> Result<(), String> {
    if env::var(agent.disabled_env()).ok().as_deref() == Some("1") {
        println!("{{}}");
        return Ok(());
    }

    let payload = read_hook_payload();
    let outcome = agent_adapter(agent).handle_event(event, &payload);

    if env::var_os("WMUX_SURFACE_ID").is_some() {
        if let Some(params) = hook_session_params(agent, event, &payload) {
            let _ = crate::send_request_value("agent-session", Value::Object(params));
        }

        if let Some(notification) = outcome.notification {
            let mut params = Map::new();
            params.insert("title".to_string(), json!(notification.title));
            params.insert("body".to_string(), json!(notification.body));
            params.insert("source".to_string(), json!(agent.name()));
            params.insert("event".to_string(), json!(event.name()));
            insert_env(&mut params, "workspace_id", "WMUX_WORKSPACE_ID");
            insert_env(&mut params, "surface_id", "WMUX_SURFACE_ID");

            let _ = crate::send_request_value("notify", Value::Object(params));
        }
    }

    println!("{{}}");
    Ok(())
}

fn hook_session_params(
    agent: Agent,
    event: AgentHookEvent,
    payload: &Value,
) -> Option<Map<String, Value>> {
    if !records_agent_session(agent, event) {
        return None;
    }

    let session_id = payload_string(
        payload,
        &[
            "session_id",
            "sessionId",
            "conversation_id",
            "conversationId",
        ],
    )?;
    if !is_valid_agent_session_id(&session_id) {
        return None;
    }

    let mut params = Map::new();
    params.insert("source".to_string(), json!(agent.name()));
    params.insert("event".to_string(), json!(event.name()));
    params.insert("session_id".to_string(), json!(session_id));
    if let Some(cwd) = payload_string(
        payload,
        &[
            "cwd",
            "working_directory",
            "workingDirectory",
            "project_dir",
            "projectDir",
            "project_path",
            "projectPath",
            "workspacePaths",
        ],
    ) {
        params.insert("cwd".to_string(), json!(cwd));
    }
    insert_env(&mut params, "workspace_id", "WMUX_WORKSPACE_ID");
    insert_env(&mut params, "surface_id", "WMUX_SURFACE_ID");
    insert_env(
        &mut params,
        "agent_session_token",
        "WMUX_AGENT_SESSION_TOKEN",
    );
    Some(params)
}

fn is_valid_agent_session_id(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 512
        && !trimmed.starts_with('-')
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn records_agent_session(agent: Agent, event: AgentHookEvent) -> bool {
    matches!(
        event,
        AgentHookEvent::SessionStart | AgentHookEvent::UserPromptSubmit | AgentHookEvent::Stop
    ) || matches!(
        (agent, event),
        (
            Agent::Claude,
            AgentHookEvent::Notification | AgentHookEvent::SessionEnd
        )
    )
}

fn insert_env(map: &mut Map<String, Value>, key: &str, env_key: &str) {
    if let Some(value) = env::var(env_key).ok().filter(|value| !value.is_empty()) {
        map.insert(key.to_string(), json!(value));
    }
}

fn read_hook_payload() -> Value {
    let mut stdin = io::stdin();
    if stdin.is_terminal() {
        return Value::Null;
    }

    let mut raw = String::new();
    if stdin.read_to_string(&mut raw).is_err() || raw.trim().is_empty() {
        return Value::Null;
    }
    serde_json::from_str(&raw).unwrap_or(Value::Null)
}

fn payload_string(payload: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        let Some(value) = payload.get(*key) else {
            continue;
        };
        if let Some(text) = value.as_str().filter(|text| !text.trim().is_empty()) {
            return Some(text.trim().to_string());
        }
        if let Some(items) = value.as_array() {
            for item in items {
                if let Some(text) = item.as_str().filter(|text| !text.trim().is_empty()) {
                    return Some(text.trim().to_string());
                }
            }
        }
    }
    None
}

fn read_json_object(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }

    let content =
        fs::read_to_string(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(Map::new());
    }

    match serde_json::from_str::<Value>(&content) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(format!("{} is not a JSON object", path.display())),
        Err(e) => Err(format!("{} is not valid JSON: {e}", path.display())),
    }
}

fn take_hooks_object(config: &mut Map<String, Value>) -> Result<Map<String, Value>, String> {
    match config.remove("hooks") {
        Some(Value::Object(hooks)) => Ok(hooks),
        Some(_) => Err("Existing hooks value is not a JSON object".to_string()),
        None => Ok(Map::new()),
    }
}

fn insert_hook_group(hooks: &mut Map<String, Value>, agent: Agent, event: AgentHookEvent) {
    let event_name = event.name().to_string();
    let mut groups = match hooks.remove(&event_name) {
        Some(Value::Array(groups)) => groups,
        Some(value) => vec![value],
        None => Vec::new(),
    };
    groups.push(hook_group(agent, event));
    hooks.insert(event_name, Value::Array(groups));
}

fn hook_group(agent: Agent, event: AgentHookEvent) -> Value {
    let mut hook = Map::new();
    hook.insert("type".to_string(), json!("command"));
    let current_exe = env::current_exe().ok();
    hook.insert(
        "command".to_string(),
        json!(hook_command(
            agent.name(),
            agent.disabled_env(),
            event.name(),
            current_exe.as_deref()
        )),
    );
    if agent == Agent::Codex {
        hook.insert("timeout".to_string(), json!(5));
    }

    let mut group = Map::new();
    if agent == Agent::Claude {
        group.insert("matcher".to_string(), json!(""));
    }
    group.insert("hooks".to_string(), Value::Array(vec![Value::Object(hook)]));
    Value::Object(group)
}

fn remove_owned_hooks(hooks: &mut Map<String, Value>, agent: Agent) -> bool {
    let mut removed_any = false;
    let events: Vec<String> = hooks.keys().cloned().collect();

    for event in events {
        let Some(value) = hooks.remove(&event) else {
            continue;
        };
        let groups = match value {
            Value::Array(groups) => groups,
            other => {
                hooks.insert(event, other);
                continue;
            }
        };
        let mut rewritten = Vec::new();

        for group in groups {
            let mut group_obj = match group {
                Value::Object(group_obj) => group_obj,
                other => {
                    rewritten.push(other);
                    continue;
                }
            };

            let Some(Value::Array(hook_list)) = group_obj.remove("hooks") else {
                rewritten.push(Value::Object(group_obj));
                continue;
            };

            let before = hook_list.len();
            let kept: Vec<Value> = hook_list
                .into_iter()
                .filter(|hook| !is_owned_hook_value(hook, agent))
                .collect();
            if kept.len() != before {
                removed_any = true;
            }

            if !kept.is_empty() {
                group_obj.insert("hooks".to_string(), Value::Array(kept));
                rewritten.push(Value::Object(group_obj));
            }
        }

        if !rewritten.is_empty() {
            hooks.insert(event, Value::Array(rewritten));
        }
    }

    removed_any
}

fn is_owned_hook_value(value: &Value, agent: Agent) -> bool {
    let Some(command) = value.get("command").and_then(Value::as_str) else {
        return false;
    };
    command.contains(&format!("wmux hooks {}", agent.name()))
        || command.contains(&format!("wmux-cli hooks {}", agent.name()))
        || command.contains(&format!("hooks {} ", agent.name()))
}

fn write_json_if_changed(
    path: &Path,
    config: &Map<String, Value>,
    yes: bool,
    label: &str,
) -> Result<(), String> {
    let new_content = serde_json::to_string_pretty(&Value::Object(config.clone()))
        .map_err(|e| format!("Could not serialize JSON: {e}"))?
        + "\n";
    write_text_if_changed(path, &new_content, yes, label)
}

fn write_text_if_changed(
    path: &Path,
    new_content: &str,
    yes: bool,
    label: &str,
) -> Result<(), String> {
    let old_content = fs::read_to_string(path).unwrap_or_default();
    if old_content == new_content {
        println!("{label} already up to date at {}", path.display());
        return Ok(());
    }

    if !yes && !confirm_write(path)? {
        println!("Aborted.");
        return Ok(());
    }

    atomic_write(path, new_content)?;
    println!("{label} updated at {}", path.display());
    Ok(())
}

fn confirm_write(path: &Path) -> Result<bool, String> {
    print!("Update {}? [y/N] ", path.display());
    io::stdout()
        .flush()
        .map_err(|e| format!("Could not flush stdout: {e}"))?;
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|e| format!("Could not read confirmation: {e}"))?;
    Ok(answer.trim().eq_ignore_ascii_case("y") || answer.trim().eq_ignore_ascii_case("yes"))
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }

    let tmp = path.with_extension(format!(
        "{}.tmp-{}",
        path.extension().and_then(|ext| ext.to_str()).unwrap_or(""),
        std::process::id()
    ));
    fs::write(&tmp, content).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    replace_file(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not replace {}: {e}", path.display())
    })?;
    Ok(())
}

fn install_codex_hooks_feature(path: &Path, yes: bool) -> Result<(), String> {
    let content = fs::read_to_string(path).unwrap_or_default();
    let cleaned = remove_managed_block(&content);
    if codex_hooks_feature_enabled(&cleaned) {
        if cleaned != content {
            write_text_if_changed(path, &cleaned, yes, "Codex hooks feature")?;
        }
        return Ok(());
    }

    let updated = insert_codex_feature_block(&cleaned);
    write_text_if_changed(path, &updated, yes, "Codex hooks feature")
}

fn uninstall_codex_hooks_feature(path: &Path, yes: bool) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let content =
        fs::read_to_string(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let cleaned = remove_managed_block(&content);
    if cleaned == content {
        return Ok(());
    }
    write_text_if_changed(path, &cleaned, yes, "Codex hooks feature")
}

const CODEX_FEATURE_BEGIN: &str = "# wmux-codex-hooks-feature begin";
const CODEX_FEATURE_END: &str = "# wmux-codex-hooks-feature end";

fn remove_managed_block(content: &str) -> String {
    let mut out = Vec::new();
    let mut in_block = false;
    for line in content.lines() {
        if line.trim() == CODEX_FEATURE_BEGIN {
            in_block = true;
            continue;
        }
        if line.trim() == CODEX_FEATURE_END {
            in_block = false;
            continue;
        }
        if !in_block {
            out.push(line);
        }
    }
    if out.is_empty() {
        String::new()
    } else {
        out.join("\n") + "\n"
    }
}

fn codex_hooks_feature_enabled(content: &str) -> bool {
    let mut in_features = false;
    for raw in content.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_features = line == "[features]";
            continue;
        }
        if line == "features.hooks = true" || line == "features.codex_hooks = true" {
            return true;
        }
        if in_features && (line == "hooks = true" || line == "codex_hooks = true") {
            return true;
        }
    }
    false
}

fn insert_codex_feature_block(content: &str) -> String {
    let mut lines: Vec<String> = content.lines().map(ToString::to_string).collect();
    if let Some(index) = lines.iter().position(|line| line.trim() == "[features]") {
        lines.insert(index + 1, CODEX_FEATURE_END.to_string());
        lines.insert(index + 1, "hooks = true".to_string());
        lines.insert(index + 1, CODEX_FEATURE_BEGIN.to_string());
    } else {
        if !lines.is_empty() && lines.last().is_some_and(|line| !line.trim().is_empty()) {
            lines.push(String::new());
        }
        lines.push(CODEX_FEATURE_BEGIN.to_string());
        lines.push("[features]".to_string());
        lines.push("hooks = true".to_string());
        lines.push(CODEX_FEATURE_END.to_string());
    }
    lines.join("\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(events: &[AgentHookEvent]) -> Vec<&'static str> {
        events.iter().map(|event| event.name()).collect()
    }

    #[test]
    fn managed_block_round_trips() {
        let content = "a\n# wmux-codex-hooks-feature begin\n[features]\nhooks = true\n# wmux-codex-hooks-feature end\nb\n";
        assert_eq!(remove_managed_block(content), "a\nb\n");
    }

    #[test]
    fn codex_and_claude_adapters_expose_hook_interfaces() {
        assert_eq!(
            names(CODEX_ADAPTER.known_events()),
            vec![
                "SessionStart",
                "UserPromptSubmit",
                "Stop",
                "PreToolUse",
                "PermissionRequest",
            ]
        );
        assert_eq!(
            names(CLAUDE_ADAPTER.known_events()),
            vec![
                "SessionStart",
                "UserPromptSubmit",
                "Stop",
                "PreToolUse",
                "PermissionRequest",
                "Notification",
                "SessionEnd",
                "SubagentStop",
            ]
        );
        assert_eq!(
            names(CLAUDE_ADAPTER.installed_events()),
            vec![
                "SessionStart",
                "UserPromptSubmit",
                "Stop",
                "PermissionRequest",
                "Notification",
                "SessionEnd",
            ]
        );
    }

    #[test]
    fn codex_hook_install_writes_one_group_per_supported_event() {
        let mut hooks = Map::new();
        for event in CODEX_ADAPTER.installed_events() {
            insert_hook_group(&mut hooks, Agent::Codex, *event);
        }

        for event in CODEX_ADAPTER.installed_events() {
            let groups = hooks
                .get(event.name())
                .and_then(Value::as_array)
                .expect("event group");
            assert_eq!(groups.len(), 1);
            let command = groups[0]
                .get("hooks")
                .and_then(Value::as_array)
                .and_then(|hooks| hooks.first())
                .and_then(|hook| hook.get("command"))
                .and_then(Value::as_str)
                .expect("hook command");
            assert!(command.contains(&format!("hooks codex {}", event.name())));
        }
    }

    #[test]
    fn codex_notification_policy_depends_on_hook_event() {
        let stop = CODEX_ADAPTER.handle_event(
            AgentHookEvent::Stop,
            &json!({ "summary": "Tests finished" }),
        );
        assert_eq!(stop.notification.as_ref().unwrap().title, "Codex");
        assert_eq!(stop.notification.as_ref().unwrap().body, "Tests finished");

        let permission = CODEX_ADAPTER.handle_event(
            AgentHookEvent::PermissionRequest,
            &json!({ "toolName": "apply_patch" }),
        );
        assert_eq!(
            permission.notification.as_ref().unwrap().body,
            "Permission requested: apply_patch"
        );

        let prompt = CODEX_ADAPTER.handle_event(AgentHookEvent::UserPromptSubmit, &Value::Null);
        assert!(prompt.notification.is_none());
        let claude_stop = CLAUDE_ADAPTER.handle_event(
            AgentHookEvent::Stop,
            &json!({ "message": "Claude finished" }),
        );
        assert_eq!(
            claude_stop.notification.as_ref().unwrap().title,
            "Claude Code"
        );
        assert_eq!(
            claude_stop.notification.as_ref().unwrap().body,
            "Claude finished"
        );

        let claude_permission = CLAUDE_ADAPTER.handle_event(
            AgentHookEvent::PermissionRequest,
            &json!({ "tool_name": "Bash" }),
        );
        assert_eq!(
            claude_permission.notification.as_ref().unwrap().body,
            "Permission requested: Bash"
        );

        let claude_notification = CLAUDE_ADAPTER.handle_event(
            AgentHookEvent::Notification,
            &json!({ "message": "Waiting for input" }),
        );
        assert_eq!(
            claude_notification.notification.as_ref().unwrap().body,
            "Waiting for input"
        );
    }

    #[test]
    fn hook_session_params_extracts_agent_session_binding() {
        let params = hook_session_params(
            Agent::Codex,
            AgentHookEvent::SessionStart,
            &json!({
                "session_id": "11111111-2222-3333-4444-555555555555",
                "cwd": "/home/me/codex-project",
                "transcript_path": "/home/me/.codex/sessions/rollout.jsonl"
            }),
        )
        .expect("session params");

        assert_eq!(params.get("source").and_then(Value::as_str), Some("codex"));
        assert_eq!(
            params.get("event").and_then(Value::as_str),
            Some("SessionStart")
        );
        assert_eq!(
            params.get("session_id").and_then(Value::as_str),
            Some("11111111-2222-3333-4444-555555555555")
        );
        assert_eq!(
            params.get("cwd").and_then(Value::as_str),
            Some("/home/me/codex-project")
        );
        assert_eq!(params.get("transcript_path"), None);
    }

    #[test]
    fn hook_session_params_rejects_option_shaped_session_ids() {
        assert!(hook_session_params(
            Agent::Codex,
            AgentHookEvent::SessionStart,
            &json!({ "session_id": "--dangerously-bypass-approvals-and-sandbox" }),
        )
        .is_none());
        assert!(hook_session_params(
            Agent::Claude,
            AgentHookEvent::UserPromptSubmit,
            &json!({ "sessionId": "session with spaces" }),
        )
        .is_none());
        assert!(hook_session_params(
            Agent::Codex,
            AgentHookEvent::SessionStart,
            &json!({ "session_id": "abc&calc" }),
        )
        .is_none());
        assert!(hook_session_params(
            Agent::Claude,
            AgentHookEvent::UserPromptSubmit,
            &json!({ "sessionId": "abc'quote" }),
        )
        .is_none());
    }

    #[test]
    fn hook_session_params_extracts_claude_workspace_path_and_ignores_tool_events() {
        let params = hook_session_params(
            Agent::Claude,
            AgentHookEvent::UserPromptSubmit,
            &json!({
                "sessionId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "workspacePaths": ["/home/me/claude-project"],
                "transcriptPath": "/home/me/.claude/projects/session.jsonl"
            }),
        )
        .expect("session params");

        assert_eq!(params.get("source").and_then(Value::as_str), Some("claude"));
        assert_eq!(
            params.get("event").and_then(Value::as_str),
            Some("UserPromptSubmit")
        );
        assert_eq!(
            params.get("session_id").and_then(Value::as_str),
            Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        );
        assert_eq!(
            params.get("cwd").and_then(Value::as_str),
            Some("/home/me/claude-project")
        );
        assert_eq!(params.get("transcript_path"), None);

        assert!(hook_session_params(
            Agent::Claude,
            AgentHookEvent::PreToolUse,
            &json!({ "session_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
        )
        .is_none());

        assert!(hook_session_params(
            Agent::Codex,
            AgentHookEvent::Notification,
            &json!({ "session_id": "11111111-2222-3333-4444-555555555555" }),
        )
        .is_none());
    }

    #[test]
    fn hook_session_params_records_claude_session_end_for_cleanup() {
        let params = hook_session_params(
            Agent::Claude,
            AgentHookEvent::SessionEnd,
            &json!({
                "session_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "cwd": "/home/me/claude-project"
            }),
        )
        .expect("session end params");

        assert_eq!(params.get("source").and_then(Value::as_str), Some("claude"));
        assert_eq!(
            params.get("event").and_then(Value::as_str),
            Some("SessionEnd")
        );
        assert_eq!(
            params.get("session_id").and_then(Value::as_str),
            Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        );

        assert!(hook_session_params(
            Agent::Codex,
            AgentHookEvent::SessionEnd,
            &json!({ "session_id": "11111111-2222-3333-4444-555555555555" }),
        )
        .is_none());
    }
}
