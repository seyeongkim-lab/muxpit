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
    Gemini,
    Copilot,
    OpenCode,
}

impl Agent {
    fn all() -> [Agent; 5] {
        [
            Agent::Codex,
            Agent::Claude,
            Agent::Gemini,
            Agent::Copilot,
            Agent::OpenCode,
        ]
    }

    fn parse(raw: &str) -> Option<Agent> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "codex" => Some(Agent::Codex),
            "claude" | "claude-code" | "claudecode" => Some(Agent::Claude),
            "gemini" | "gemini-cli" => Some(Agent::Gemini),
            "copilot" | "github-copilot" => Some(Agent::Copilot),
            "opencode" | "open-code" => Some(Agent::OpenCode),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Agent::Codex => "codex",
            Agent::Claude => "claude",
            Agent::Gemini => "gemini",
            Agent::Copilot => "copilot",
            Agent::OpenCode => "opencode",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Agent::Codex => "Codex",
            Agent::Claude => "Claude Code",
            Agent::Gemini => "Gemini CLI",
            Agent::Copilot => "GitHub Copilot CLI",
            Agent::OpenCode => "OpenCode",
        }
    }

    fn binary_name(self) -> &'static str {
        match self {
            Agent::Codex => "codex",
            Agent::Claude => "claude",
            Agent::Gemini => "gemini",
            Agent::Copilot => "copilot",
            Agent::OpenCode => "opencode",
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
            Agent::Gemini => home_dir()
                .map(|home| home.join(".gemini"))
                .ok_or_else(|| "Could not resolve a home directory".to_string()),
            Agent::Copilot => home_dir()
                .map(|home| home.join(".copilot"))
                .ok_or_else(|| "Could not resolve a home directory".to_string()),
            Agent::OpenCode => home_dir()
                .map(|home| home.join(".config").join("opencode"))
                .ok_or_else(|| "Could not resolve a home directory".to_string()),
        }
    }

    fn config_file(self) -> &'static str {
        match self {
            Agent::Codex => "hooks.json",
            Agent::Claude => "settings.json",
            Agent::Gemini => "settings.json",
            Agent::Copilot => "hooks/muxpit.json",
            Agent::OpenCode => "plugins/muxpit.js",
        }
    }

    fn disabled_env(self) -> &'static str {
        match self {
            Agent::Codex => "MUXPIT_CODEX_HOOKS_DISABLED",
            Agent::Claude => "MUXPIT_CLAUDE_HOOKS_DISABLED",
            Agent::Gemini => "MUXPIT_GEMINI_HOOKS_DISABLED",
            Agent::Copilot => "MUXPIT_COPILOT_HOOKS_DISABLED",
            Agent::OpenCode => "MUXPIT_OPENCODE_HOOKS_DISABLED",
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
    ErrorOccurred,
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
            "erroroccurred" | "error-occurred" | "error_occurred" | "error" => {
                Some(Self::ErrorOccurred)
            }
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
            Self::ErrorOccurred => "ErrorOccurred",
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

const GEMINI_HOOK_EVENTS: &[AgentHookEvent] = &[
    AgentHookEvent::SessionStart,
    AgentHookEvent::UserPromptSubmit,
    AgentHookEvent::Stop,
    AgentHookEvent::Notification,
    AgentHookEvent::SessionEnd,
];

const COPILOT_HOOK_EVENTS: &[AgentHookEvent] = &[
    AgentHookEvent::SessionStart,
    AgentHookEvent::UserPromptSubmit,
    AgentHookEvent::Stop,
    AgentHookEvent::PermissionRequest,
    AgentHookEvent::Notification,
    AgentHookEvent::ErrorOccurred,
    AgentHookEvent::SessionEnd,
    AgentHookEvent::SubagentStop,
];

const OPENCODE_HOOK_EVENTS: &[AgentHookEvent] = &[
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
struct GeminiHookAdapter;
struct CopilotHookAdapter;
struct OpenCodeHookAdapter;

impl AgentHookAdapter for CodexHookAdapter {
    fn known_events(&self) -> &'static [AgentHookEvent] {
        CODEX_HOOK_EVENTS
    }

    fn installed_events(&self) -> &'static [AgentHookEvent] {
        CODEX_HOOK_EVENTS
    }

    fn install(&self, yes: bool) -> Result<(), String> {
        install_agent_config(Agent::Codex, self.installed_events(), yes)
    }

    fn uninstall(&self, yes: bool) -> Result<(), String> {
        uninstall_agent_config(Agent::Codex, yes)
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

fn basic_agent_outcome(title: &'static str, event: AgentHookEvent, payload: &Value) -> HookOutcome {
    let body = match event {
        AgentHookEvent::Stop | AgentHookEvent::SubagentStop => {
            payload_string(payload, &["message", "summary", "status"])
                .or_else(|| Some("Prompt completed".to_string()))
        }
        AgentHookEvent::ErrorOccurred => {
            payload_string(payload, &["message", "error", "reason", "status"])
                .or_else(|| Some("Agent error".to_string()))
        }
        AgentHookEvent::PermissionRequest => {
            payload_string(payload, &["tool_name", "toolName", "command", "message"])
                .map(|value| format!("Permission requested: {value}"))
                .or_else(|| Some("Permission requested".to_string()))
        }
        AgentHookEvent::Notification => {
            payload_string(payload, &["message", "body", "text", "status"])
                .or_else(|| Some("Needs attention".to_string()))
        }
        _ => None,
    };
    HookOutcome {
        notification: body.map(|body| HookNotification { title, body }),
    }
}

impl AgentHookAdapter for GeminiHookAdapter {
    fn known_events(&self) -> &'static [AgentHookEvent] {
        GEMINI_HOOK_EVENTS
    }

    fn installed_events(&self) -> &'static [AgentHookEvent] {
        GEMINI_HOOK_EVENTS
    }

    fn install(&self, yes: bool) -> Result<(), String> {
        install_agent_config(Agent::Gemini, self.installed_events(), yes)
    }

    fn uninstall(&self, yes: bool) -> Result<(), String> {
        uninstall_agent_config(Agent::Gemini, yes)
    }

    fn handle_event(&self, event: AgentHookEvent, payload: &Value) -> HookOutcome {
        basic_agent_outcome("Gemini CLI", event, payload)
    }
}

impl AgentHookAdapter for CopilotHookAdapter {
    fn known_events(&self) -> &'static [AgentHookEvent] {
        COPILOT_HOOK_EVENTS
    }

    fn installed_events(&self) -> &'static [AgentHookEvent] {
        COPILOT_HOOK_EVENTS
    }

    fn install(&self, yes: bool) -> Result<(), String> {
        install_copilot_hooks(yes)
    }

    fn uninstall(&self, yes: bool) -> Result<(), String> {
        uninstall_copilot_hooks(yes)
    }

    fn handle_event(&self, event: AgentHookEvent, payload: &Value) -> HookOutcome {
        basic_agent_outcome("GitHub Copilot CLI", event, payload)
    }
}

impl AgentHookAdapter for OpenCodeHookAdapter {
    fn known_events(&self) -> &'static [AgentHookEvent] {
        OPENCODE_HOOK_EVENTS
    }

    fn installed_events(&self) -> &'static [AgentHookEvent] {
        OPENCODE_HOOK_EVENTS
    }

    fn install(&self, yes: bool) -> Result<(), String> {
        install_opencode_plugin(yes)
    }

    fn uninstall(&self, yes: bool) -> Result<(), String> {
        uninstall_managed_file(Agent::OpenCode, yes)
    }

    fn handle_event(&self, event: AgentHookEvent, payload: &Value) -> HookOutcome {
        basic_agent_outcome("OpenCode", event, payload)
    }
}

static CODEX_ADAPTER: CodexHookAdapter = CodexHookAdapter;
static CLAUDE_ADAPTER: ClaudeHookAdapter = ClaudeHookAdapter;
static GEMINI_ADAPTER: GeminiHookAdapter = GeminiHookAdapter;
static COPILOT_ADAPTER: CopilotHookAdapter = CopilotHookAdapter;
static OPENCODE_ADAPTER: OpenCodeHookAdapter = OpenCodeHookAdapter;

fn agent_adapter(agent: Agent) -> &'static dyn AgentHookAdapter {
    match agent {
        Agent::Codex => &CODEX_ADAPTER,
        Agent::Claude => &CLAUDE_ADAPTER,
        Agent::Gemini => &GEMINI_ADAPTER,
        Agent::Copilot => &COPILOT_ADAPTER,
        Agent::OpenCode => &OPENCODE_ADAPTER,
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
    let agents = Agent::all()
        .iter()
        .map(|agent| agent.name())
        .collect::<Vec<_>>()
        .join("|");
    let event_lines = Agent::all()
        .iter()
        .map(|agent| {
            let events = agent_adapter(*agent)
                .known_events()
                .iter()
                .map(|event| event.name())
                .collect::<Vec<_>>()
                .join(", ");
            format!("  {}: {events}", agent.name())
        })
        .collect::<Vec<_>>()
        .join("\n");
    println!(
        "muxpit-cli hooks - install and run agent notification hooks

Usage:
  muxpit-cli hooks setup [{agents}] [--agent <agent>] [--yes|-y]
  muxpit-cli hooks uninstall [{agents}] [--agent <agent>] [--yes|-y]
  muxpit-cli hooks <agent> install [--yes|-y]
  muxpit-cli hooks <agent> uninstall [--yes|-y]
  muxpit-cli hooks <agent> <event>

Known events:
{event_lines}

Installed hooks no-op unless MUXPIT_SURFACE_ID is present."
    );
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
        println!("Removed 0 muxpit hook(s) from {}", config_path.display());
    }

    Ok(())
}

fn copilot_hooks_config() -> Value {
    let current_exe = env::current_exe().ok();
    let event_map = [
        ("sessionStart", AgentHookEvent::SessionStart),
        ("userPromptSubmitted", AgentHookEvent::UserPromptSubmit),
        ("agentStop", AgentHookEvent::Stop),
        ("permissionRequest", AgentHookEvent::PermissionRequest),
        ("notification", AgentHookEvent::Notification),
        ("errorOccurred", AgentHookEvent::ErrorOccurred),
        ("sessionEnd", AgentHookEvent::SessionEnd),
        ("subagentStop", AgentHookEvent::SubagentStop),
    ];
    let mut hooks = Map::new();
    for (event_name, event) in event_map {
        let mut hook = Map::new();
        hook.insert("type".to_string(), json!("command"));
        #[cfg(not(windows))]
        hook.insert(
            "bash".to_string(),
            json!(hook_command(
                Agent::Copilot.name(),
                Agent::Copilot.disabled_env(),
                event.name(),
                current_exe.as_deref(),
            )),
        );
        #[cfg(windows)]
        hook.insert(
            "powershell".to_string(),
            json!(hook_command(
                Agent::Copilot.name(),
                Agent::Copilot.disabled_env(),
                event.name(),
                current_exe.as_deref(),
            )),
        );
        hook.insert("timeoutSec".to_string(), json!(5));
        hooks.insert(event_name.to_string(), json!([Value::Object(hook)]));
    }
    json!({ "version": 1, "hooks": hooks })
}

fn install_copilot_hooks(yes: bool) -> Result<(), String> {
    let path = Agent::Copilot
        .config_dir()?
        .join(Agent::Copilot.config_file());
    let config = merge_copilot_hooks(read_json_object(&path)?)?;
    write_json_if_changed(&path, &config, yes, "GitHub Copilot CLI hooks")
}

fn merge_copilot_hooks(mut config: Map<String, Value>) -> Result<Map<String, Value>, String> {
    if let Some(version) = config.get("version") {
        if version != &json!(1) {
            return Err("Existing GitHub Copilot CLI hook version is not 1".to_string());
        }
    }

    let mut hooks = take_copilot_hooks_object(&mut config)?;
    remove_owned_copilot_hook_values(&mut hooks)?;

    let Value::Object(mut generated) = copilot_hooks_config() else {
        unreachable!();
    };
    let generated_hooks = take_copilot_hooks_object(&mut generated)?;
    for (event, value) in generated_hooks {
        let Value::Array(mut generated_entries) = value else {
            unreachable!();
        };
        let mut entries = match hooks.remove(&event) {
            Some(Value::Array(entries)) => entries,
            Some(_) => return Err(format!("Existing Copilot hook {event} is not an array")),
            None => Vec::new(),
        };
        entries.append(&mut generated_entries);
        hooks.insert(event, Value::Array(entries));
    }

    config.insert("version".to_string(), json!(1));
    config.insert("hooks".to_string(), Value::Object(hooks));
    Ok(config)
}

fn uninstall_copilot_hooks(yes: bool) -> Result<(), String> {
    let path = Agent::Copilot
        .config_dir()?
        .join(Agent::Copilot.config_file());
    if !path.exists() {
        println!("No GitHub Copilot CLI hooks found at {}", path.display());
        return Ok(());
    }

    let mut config = read_json_object(&path)?;
    if !remove_owned_copilot_hooks(&mut config)? {
        println!("Removed 0 muxpit hook(s) from {}", path.display());
        return Ok(());
    }
    write_json_if_changed(&path, &config, yes, "GitHub Copilot CLI hooks")
}

fn take_copilot_hooks_object(
    config: &mut Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    match config.remove("hooks") {
        Some(Value::Object(hooks)) => Ok(hooks),
        Some(_) => Err("Existing Copilot hooks value is not a JSON object".to_string()),
        None => Ok(Map::new()),
    }
}

fn remove_owned_copilot_hook_values(hooks: &mut Map<String, Value>) -> Result<bool, String> {
    let mut removed = false;
    for (event, value) in hooks.iter_mut() {
        let Value::Array(entries) = value else {
            return Err(format!("Existing Copilot hook {event} is not an array"));
        };
        let before = entries.len();
        entries.retain(|entry| !is_owned_copilot_hook(entry));
        removed |= entries.len() != before;
    }
    hooks.retain(|_, value| value.as_array().is_some_and(|entries| !entries.is_empty()));
    Ok(removed)
}

fn remove_owned_copilot_hooks(config: &mut Map<String, Value>) -> Result<bool, String> {
    let mut hooks = take_copilot_hooks_object(config)?;
    let removed = remove_owned_copilot_hook_values(&mut hooks)?;
    if !hooks.is_empty() {
        config.insert("hooks".to_string(), Value::Object(hooks));
    }
    Ok(removed)
}

fn is_owned_copilot_hook(value: &Value) -> bool {
    ["bash", "powershell"].iter().any(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|command| command.contains("hooks copilot "))
    })
}

const OPENCODE_PLUGIN_MARKER: &str = "muxpit-opencode-plugin";

fn opencode_plugin_source(binary: &Path) -> String {
    let binary = serde_json::to_string(binary.to_string_lossy().as_ref())
        .unwrap_or_else(|_| "\"muxpit-cli\"".to_string());
    format!(
        r#"// {OPENCODE_PLUGIN_MARKER}
import {{ spawn }} from "node:child_process"

const muxpitCli = {binary}

const report = (hookEvent, payload) => new Promise((resolve) => {{
  const child = spawn(muxpitCli, ["hooks", "opencode", hookEvent], {{
    env: process.env,
    stdio: ["pipe", "ignore", "ignore"],
  }})
  child.on("error", () => resolve())
  child.on("close", () => resolve())
  child.stdin?.end(JSON.stringify(payload))
}})

export const MuxpitPlugin = async ({{ directory }}) => ({{
  event: async ({{ event }}) => {{
    const properties = event.properties ?? {{}}
    const info = properties.info ?? {{}}
    const sessionId = info.id ?? properties.sessionID
    if (!sessionId) return

    const payload = {{ sessionId, cwd: info.directory ?? directory }}
    if (event.type === "session.created") await report("SessionStart", payload)
    if (event.type === "session.deleted") await report("SessionEnd", payload)
    if (event.type === "session.idle") await report("Stop", {{ ...payload, message: "done" }})
    if (event.type === "session.error") await report("Notification", {{ ...payload, message: "error" }})
    if (event.type === "permission.asked") {{
      await report("PermissionRequest", {{ ...payload, message: properties.title ?? "Permission requested" }})
    }}
    if (event.type === "session.status" && properties.status?.type === "busy") {{
      await report("UserPromptSubmit", {{ ...payload, prompt: "working" }})
    }}
  }},
}})
"#
    )
}

fn install_opencode_plugin(yes: bool) -> Result<(), String> {
    let binary = env::current_exe().map_err(|e| format!("Could not resolve muxpit-cli: {e}"))?;
    let path = Agent::OpenCode
        .config_dir()?
        .join(Agent::OpenCode.config_file());
    write_text_if_changed(
        &path,
        &opencode_plugin_source(&binary),
        yes,
        "OpenCode plugin",
    )
}

fn uninstall_managed_file(agent: Agent, yes: bool) -> Result<(), String> {
    let path = agent.config_dir()?.join(agent.config_file());
    if !path.exists() {
        println!(
            "No {} integration found at {}",
            agent.display_name(),
            path.display()
        );
        return Ok(());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let marker = match agent {
        Agent::Copilot => "muxpit-cli hooks copilot",
        Agent::OpenCode => OPENCODE_PLUGIN_MARKER,
        _ => return Err("Managed file uninstall is not supported for this agent".to_string()),
    };
    if !content.contains(marker) {
        return Err(format!(
            "Refusing to remove unmanaged file {}",
            path.display()
        ));
    }
    if !yes && !confirm_remove(&path)? {
        println!("Aborted.");
        return Ok(());
    }
    fs::remove_file(&path).map_err(|e| format!("Could not remove {}: {e}", path.display()))?;
    println!(
        "{} integration removed from {}",
        agent.display_name(),
        path.display()
    );
    Ok(())
}

fn run_agent_hook(agent: Agent, event: AgentHookEvent) -> Result<(), String> {
    if env::var(agent.disabled_env()).ok().as_deref() == Some("1") {
        println!("{{}}");
        return Ok(());
    }

    let payload = read_hook_payload();
    let outcome = agent_adapter(agent).handle_event(event, &payload);

    if env::var_os("MUXPIT_SURFACE_ID").is_some() {
        if let Some(params) = hook_session_params(agent, event, &payload) {
            let _ = crate::send_request_value("agent-session", Value::Object(params));
        }

        if let Some(notification) = outcome.notification {
            let mut params = Map::new();
            params.insert("title".to_string(), json!(notification.title));
            params.insert("body".to_string(), json!(notification.body));
            params.insert("source".to_string(), json!(agent.name()));
            params.insert("event".to_string(), json!(event.name()));
            insert_env(&mut params, "workspace_id", "MUXPIT_WORKSPACE_ID");
            insert_env(&mut params, "surface_id", "MUXPIT_SURFACE_ID");

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
    if let Some(status) = hook_status_text(event, payload) {
        params.insert("status".to_string(), json!(status));
    }
    insert_env(&mut params, "workspace_id", "MUXPIT_WORKSPACE_ID");
    insert_env(&mut params, "surface_id", "MUXPIT_SURFACE_ID");
    insert_env(
        &mut params,
        "agent_session_token",
        "MUXPIT_AGENT_SESSION_TOKEN",
    );
    Some(params)
}

fn hook_status_text(event: AgentHookEvent, payload: &Value) -> Option<String> {
    let value = match event {
        AgentHookEvent::UserPromptSubmit => payload_string(
            payload,
            &[
                "prompt",
                "user_prompt",
                "userPrompt",
                "message",
                "text",
                "input",
            ],
        ),
        AgentHookEvent::Stop | AgentHookEvent::SubagentStop => {
            payload_string(payload, &["message", "summary"]).or_else(|| Some("done".to_string()))
        }
        AgentHookEvent::Notification => payload_string(payload, &["message", "body", "text"]),
        _ => None,
    }?;
    Some(value.chars().take(512).collect())
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
            Agent::Claude | Agent::Copilot | Agent::OpenCode,
            AgentHookEvent::Notification | AgentHookEvent::SessionEnd
        )
    ) || matches!((agent, event), (Agent::Gemini, AgentHookEvent::SessionEnd))
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
    let event_name = installed_event_name(agent, event).to_string();
    let mut groups = match hooks.remove(&event_name) {
        Some(Value::Array(groups)) => groups,
        Some(value) => vec![value],
        None => Vec::new(),
    };
    groups.push(hook_group(agent, event));
    hooks.insert(event_name, Value::Array(groups));
}

fn installed_event_name(agent: Agent, event: AgentHookEvent) -> &'static str {
    match (agent, event) {
        (Agent::Gemini, AgentHookEvent::UserPromptSubmit) => "BeforeAgent",
        (Agent::Gemini, AgentHookEvent::Stop) => "AfterAgent",
        _ => event.name(),
    }
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
    if agent == Agent::Gemini {
        hook.insert("name".to_string(), json!("muxpit"));
    }

    let mut group = Map::new();
    if agent == Agent::Claude {
        group.insert("matcher".to_string(), json!(""));
    }
    if agent == Agent::Gemini {
        group.insert("matcher".to_string(), json!("*"));
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
    command.contains(&format!("muxpit hooks {}", agent.name()))
        || command.contains(&format!("muxpit-cli hooks {}", agent.name()))
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

fn confirm_remove(path: &Path) -> Result<bool, String> {
    print!("Remove {}? [y/N] ", path.display());
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

#[cfg(test)]
mod tests {
    use super::*;

    fn names(events: &[AgentHookEvent]) -> Vec<&'static str> {
        events.iter().map(|event| event.name()).collect()
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
    fn hook_setup_covers_all_restorable_agents() {
        assert_eq!(
            Agent::all().map(Agent::name),
            ["codex", "claude", "gemini", "copilot", "opencode"]
        );
        assert_eq!(
            names(GEMINI_ADAPTER.installed_events()),
            vec![
                "SessionStart",
                "UserPromptSubmit",
                "Stop",
                "Notification",
                "SessionEnd",
            ]
        );
        assert_eq!(
            GEMINI_ADAPTER
                .installed_events()
                .iter()
                .map(|event| installed_event_name(Agent::Gemini, *event))
                .collect::<Vec<_>>(),
            vec![
                "SessionStart",
                "BeforeAgent",
                "AfterAgent",
                "Notification",
                "SessionEnd",
            ]
        );
        assert!(copilot_hooks_config().to_string().contains("sessionStart"));
        assert!(copilot_hooks_config().to_string().contains("errorOccurred"));
        assert!(opencode_plugin_source(Path::new("/tmp/muxpit-cli")).contains("session.created"));
        assert!(opencode_plugin_source(Path::new("/tmp/muxpit-cli")).contains("permission.asked"));
        assert!(!opencode_plugin_source(Path::new("/tmp/muxpit-cli")).contains("permission.updated"));
    }

    #[test]
    fn copilot_hook_merge_and_remove_preserve_unowned_entries() {
        let existing = json!({
            "version": 1,
            "custom": true,
            "hooks": {
                "agentStop": [{ "type": "command", "bash": "custom-stop" }],
                "customEvent": [{ "type": "command", "bash": "custom-event" }]
            }
        });
        let Value::Object(existing) = existing else {
            unreachable!();
        };

        let merged = merge_copilot_hooks(existing).expect("merged config");
        assert_eq!(merged.get("custom"), Some(&json!(true)));
        assert_eq!(
            merged["hooks"]["agentStop"].as_array().map(Vec::len),
            Some(2)
        );
        assert_eq!(merged["hooks"]["customEvent"][0]["bash"], "custom-event");

        let mut merged_twice = merge_copilot_hooks(merged).expect("idempotent merge");
        assert_eq!(
            merged_twice["hooks"]["agentStop"].as_array().map(Vec::len),
            Some(2)
        );
        assert!(remove_owned_copilot_hooks(&mut merged_twice).expect("remove hooks"));
        assert_eq!(
            merged_twice["hooks"]["agentStop"].as_array().map(Vec::len),
            Some(1)
        );
        assert_eq!(
            merged_twice["hooks"]["customEvent"][0]["bash"],
            "custom-event"
        );
    }

    #[test]
    fn new_agent_hooks_extract_session_ids() {
        for agent in [Agent::Gemini, Agent::Copilot, Agent::OpenCode] {
            let params = hook_session_params(
                agent,
                AgentHookEvent::SessionStart,
                &json!({
                    "sessionId": "ses_1234567890",
                    "cwd": "/work/project"
                }),
            )
            .expect("session params");
            assert_eq!(
                params.get("source").and_then(Value::as_str),
                Some(agent.name())
            );
            assert_eq!(
                params.get("session_id").and_then(Value::as_str),
                Some("ses_1234567890")
            );
        }
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
        assert_eq!(params.get("status"), None);
        assert_eq!(params.get("transcript_path"), None);
    }

    #[test]
    fn hook_session_params_extracts_prompt_status() {
        let params = hook_session_params(
            Agent::Codex,
            AgentHookEvent::UserPromptSubmit,
            &json!({
                "session_id": "11111111-2222-3333-4444-555555555555",
                "prompt": "Implement AI tab status"
            }),
        )
        .expect("session params");

        assert_eq!(
            params.get("status").and_then(Value::as_str),
            Some("Implement AI tab status")
        );
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
                "prompt": "Review the failing test",
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
        assert_eq!(
            params.get("status").and_then(Value::as_str),
            Some("Review the failing test")
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
