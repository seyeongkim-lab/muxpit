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

#[cfg(all(unix, not(target_os = "linux")))]
pub fn list_fonts_sync() -> Vec<String> {
    vec![]
}
