use crate::shell_quote::quote_posix_shell_arg;
use serde::Deserialize;

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchSettings {
    pub model: Option<String>,
    pub effort: Option<String>,
}

fn valid_model(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('-')
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:/@-".contains(character))
}

fn valid_effort(value: &str) -> bool {
    matches!(value, "low" | "medium" | "high" | "xhigh" | "max")
}

pub fn claude_launch_args(settings: Option<&AgentLaunchSettings>) -> Result<String, String> {
    let Some(settings) = settings else {
        return Ok(String::new());
    };
    let mut args = String::new();
    if let Some(model) = settings.model.as_deref() {
        if !valid_model(model) {
            return Err("Invalid Claude model".into());
        }
        args.push_str(" --model ");
        args.push_str(&quote_posix_shell_arg(model));
    }
    if let Some(effort) = settings.effort.as_deref() {
        if !valid_effort(effort) {
            return Err("Invalid Claude effort".into());
        }
        args.push_str(" --effort ");
        args.push_str(&quote_posix_shell_arg(effort));
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_settings_are_quoted() {
        let args = claude_launch_args(Some(&AgentLaunchSettings {
            model: Some("claude-model".into()),
            effort: Some("high".into()),
        }))
        .unwrap();

        assert_eq!(args, " --model 'claude-model' --effort 'high'");
        assert!(claude_launch_args(Some(&AgentLaunchSettings {
            model: None,
            effort: Some("invalid".into()),
        }))
        .is_err());
        assert!(claude_launch_args(Some(&AgentLaunchSettings {
            model: Some("safe' --permission-mode manual 'tail".into()),
            effort: None,
        }))
        .is_err());
    }
}
