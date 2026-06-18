use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::io::{self, Write};
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
                .ok_or_else(|| "Could not resolve CODEX_HOME or HOME".to_string()),
            Agent::Claude => env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| home_dir().map(|home| home.join(".claude")))
                .ok_or_else(|| "Could not resolve CLAUDE_CONFIG_DIR or HOME".to_string()),
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

    fn event_name(self) -> &'static str {
        "Stop"
    }

    fn notify_body(self) -> &'static str {
        "Prompt completed"
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
                .ok_or_else(|| "Missing hooks action. Try: install, uninstall, stop".to_string())?;
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
                "stop" | "notification" | "notify" => run_agent_hook(agent, action),
                other => Err(format!("Unknown hooks action: {other}")),
            }
        }
    }
}

fn print_hooks_help() {
    println!(
        r#"wmux hooks - install and run agent notification hooks

Usage:
  wmux hooks setup [codex|claude] [--agent <agent>] [--yes|-y]
  wmux hooks uninstall [codex|claude] [--agent <agent>] [--yes|-y]
  wmux hooks <codex|claude> install [--yes|-y]
  wmux hooks <codex|claude> uninstall [--yes|-y]
  wmux hooks <codex|claude> stop

Installed hooks no-op unless WMUX_SURFACE_ID is present."#
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
    let config_dir = agent.config_dir()?;
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Could not create {}: {e}", config_dir.display()))?;
    let config_path = config_dir.join(agent.config_file());
    let mut config = read_json_object(&config_path)?;
    let mut hooks = take_hooks_object(&mut config)?;
    let insertion_index = remove_owned_hooks(&mut hooks, agent);

    insert_hook_group(&mut hooks, agent, insertion_index);
    config.insert("hooks".to_string(), Value::Object(hooks));

    write_json_if_changed(
        &config_path,
        &config,
        yes,
        &format!("{} hooks", agent.display_name()),
    )?;

    if agent == Agent::Codex {
        install_codex_hooks_feature(&config_dir.join("config.toml"), yes)?;
    }

    Ok(())
}

fn uninstall_agent(agent: Agent, yes: bool) -> Result<(), String> {
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
    let removed = remove_owned_hooks(&mut hooks, agent).is_some();

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

    if agent == Agent::Codex {
        uninstall_codex_hooks_feature(&config_dir.join("config.toml"), yes)?;
    }

    Ok(())
}

fn run_agent_hook(agent: Agent, action: &str) -> Result<(), String> {
    if env::var_os("WMUX_SURFACE_ID").is_some() {
        let mut params = Map::new();
        params.insert("title".to_string(), json!(agent.display_name()));
        params.insert("body".to_string(), json!(agent.notify_body()));
        params.insert("source".to_string(), json!(agent.name()));
        params.insert("event".to_string(), json!(action));
        insert_env(&mut params, "workspace_id", "WMUX_WORKSPACE_ID");
        insert_env(&mut params, "surface_id", "WMUX_SURFACE_ID");

        let _ = crate::send_request_value("notify", Value::Object(params));
    }

    println!("{{}}");
    Ok(())
}

fn insert_env(map: &mut Map<String, Value>, key: &str, env_key: &str) {
    if let Some(value) = env::var(env_key).ok().filter(|value| !value.is_empty()) {
        map.insert(key.to_string(), json!(value));
    }
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

fn insert_hook_group(hooks: &mut Map<String, Value>, agent: Agent, insertion_index: Option<usize>) {
    let event = agent.event_name().to_string();
    let mut groups = match hooks.remove(&event) {
        Some(Value::Array(groups)) => groups,
        Some(value) => vec![value],
        None => Vec::new(),
    };
    let group = hook_group(agent);
    if let Some(index) = insertion_index {
        groups.insert(index.min(groups.len()), group);
    } else {
        groups.push(group);
    }
    hooks.insert(event, Value::Array(groups));
}

fn hook_group(agent: Agent) -> Value {
    let mut hook = Map::new();
    hook.insert("type".to_string(), json!("command"));
    hook.insert("command".to_string(), json!(hook_shell_command(agent)));
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

fn hook_shell_command(agent: Agent) -> String {
    let current_exe = env::current_exe().ok();
    let current_exe = current_exe
        .as_ref()
        .map(|path| shell_single_quote(&path.to_string_lossy()))
        .unwrap_or_else(|| "\"\"".to_string());
    let marker = shell_single_quote(&format!("wmux hooks {}", agent.name()));

    format!(
        ": {marker}; wmux_cli=\"${{WMUX_BUNDLED_CLI_PATH:-}}\"; \
         if [ -z \"$wmux_cli\" ] || [ ! -x \"$wmux_cli\" ]; then wmux_cli={current_exe}; fi; \
         if [ -n \"${{WMUX_SURFACE_ID:-}}\" ] && [ \"${{{disabled}:-}}\" != \"1\" ] && [ -n \"$wmux_cli\" ] && [ -x \"$wmux_cli\" ]; then \
         \"$wmux_cli\" hooks {agent} stop || echo '{{}}'; else echo '{{}}'; fi",
        marker = marker,
        current_exe = current_exe,
        disabled = agent.disabled_env(),
        agent = agent.name(),
    )
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn remove_owned_hooks(hooks: &mut Map<String, Value>, agent: Agent) -> Option<usize> {
    let mut insertion_index = None;
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
            if kept.len() != before && event == agent.event_name() && insertion_index.is_none() {
                insertion_index = Some(rewritten.len());
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

    insertion_index
}

fn is_owned_hook_value(value: &Value, agent: Agent) -> bool {
    let Some(command) = value.get("command").and_then(Value::as_str) else {
        return false;
    };
    command.contains(&format!("wmux hooks {}", agent.name()))
        || command.contains(&format!("hooks {} stop", agent.name()))
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
    fs::rename(&tmp, path).map_err(|e| {
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

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn binary_on_path(name: &str) -> bool {
    env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}
