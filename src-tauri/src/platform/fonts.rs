use super::command::silent_command;

#[cfg(windows)]
pub fn list_fonts_sync() -> Vec<String> {
    let output = silent_command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            r#"[System.Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }"#,
        ])
        .output();

    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect(),
        _ => vec![],
    }
}

#[cfg(target_os = "linux")]
pub fn list_fonts_sync() -> Vec<String> {
    let output = silent_command("fc-list").args([":family"]).output();

    match output {
        Ok(o) if o.status.success() => {
            let mut fonts: Vec<String> = String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
                .collect();
            fonts.sort();
            fonts.dedup();
            fonts
        }
        _ => vec![],
    }
}

#[cfg(target_os = "macos")]
pub fn list_fonts_sync() -> Vec<String> {
    let output = silent_command("system_profiler")
        .args(["SPFontsDataType", "-detailLevel", "mini"])
        .output();

    match output {
        Ok(o) if o.status.success() => parse_macos_fonts(&String::from_utf8_lossy(&o.stdout)),
        _ => vec![],
    }
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_fonts(text: &str) -> Vec<String> {
    let mut fonts: Vec<String> = text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            line.strip_prefix("Full Name:")
                .or_else(|| line.strip_prefix("Family:"))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .collect();
    fonts.sort();
    fonts.dedup();
    fonts
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn list_fonts_sync() -> Vec<String> {
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_macos_fonts_extracts_names() {
        let fonts = parse_macos_fonts(
            "Fonts:\n    Font A:\n      Full Name: Example Mono\n      Family: Example\n",
        );
        assert_eq!(fonts, vec!["Example", "Example Mono"]);
    }
}
