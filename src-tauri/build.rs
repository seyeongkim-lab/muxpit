fn main() {
    prepare_cli_sidecar();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "spawn_pty",
            "spawn_pty_tmux_cc",
            "subscribe_pty_events",
            "write_pty",
            "resize_pty",
            "kill_pty",
            "get_workspace_info",
            "get_ports",
            "get_pty_pid",
            "get_shell_ctx",
            "get_session_metadata",
            "pty_has_agent_process",
            "list_fonts",
            "read_dir",
            "remote_read_dir",
            "start_monitor",
            "stop_monitor",
            "request_session_content",
            "resolve_control_request",
            "check_remote_clis",
            "check_remote_tmux",
            "save_image_locally",
            "push_image_to_remote",
            "tmux_list_sessions",
            "tmux_active_pane_cwd",
            "tmux_switch_client",
            "tmux_new_session",
            "tmux_kill_session",
            "set_workspace_list",
            "send_notification",
            "install_cli_symlink",
            "browser_create",
            "browser_update_bounds",
            "browser_set_visible",
            "browser_close",
            "browser_navigate",
            "browser_reload",
            "browser_current_url",
            "browser_snapshot",
            "browser_console_logs",
            "browser_screenshot",
        ]),
    ))
    .expect("failed to build tauri application")
}

fn prepare_cli_sidecar() {
    let target = std::env::var("TARGET").expect("TARGET is set by Cargo build scripts");
    let host = std::env::var("HOST").expect("HOST is set by Cargo build scripts");
    let repo_root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .parent()
        .expect("src-tauri has a parent")
        .to_path_buf();

    println!("cargo:rerun-if-changed=../wmux-cli/Cargo.toml");
    println!("cargo:rerun-if-changed=../wmux-cli/src");
    println!("cargo:rerun-if-changed=../crates/wmux-platform/src");

    let sidecar_dir = repo_root.join("target").join("sidecars");
    let sidecar_path = sidecar_dir.join(sidecar_name(&target));

    std::fs::create_dir_all(&sidecar_dir).expect("failed to create sidecar directory");

    let profile = std::env::var("PROFILE").unwrap_or_default();
    if target != host && profile != "release" {
        std::fs::write(
            &sidecar_path,
            format!("wmux-cli sidecar placeholder for {target}\n"),
        )
        .unwrap_or_else(|e| {
            panic!(
                "failed to create wmux-cli placeholder sidecar {}: {e}",
                sidecar_path.display()
            )
        });
        return;
    }

    let mut cargo =
        std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    cargo.current_dir(&repo_root).args([
        "build",
        "--manifest-path",
        "wmux-cli/Cargo.toml",
        "--release",
    ]);
    if target != host {
        cargo.args(["--target", &target]);
    }

    let status = cargo.status().expect("failed to run cargo for wmux-cli");
    if !status.success() {
        panic!("failed to build wmux-cli sidecar for {target}");
    }

    let cli_output = if target == host {
        repo_root
            .join("wmux-cli")
            .join("target")
            .join("release")
            .join(cli_executable_name(&target))
    } else {
        repo_root
            .join("wmux-cli")
            .join("target")
            .join(&target)
            .join("release")
            .join(cli_executable_name(&target))
    };

    std::fs::copy(&cli_output, &sidecar_path).unwrap_or_else(|e| {
        panic!(
            "failed to copy wmux-cli sidecar {} -> {}: {e}",
            cli_output.display(),
            sidecar_path.display()
        )
    });

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&sidecar_path)
            .expect("failed to stat wmux-cli sidecar")
            .permissions();
        permissions.set_mode(permissions.mode() | 0o755);
        std::fs::set_permissions(&sidecar_path, permissions)
            .expect("failed to chmod wmux-cli sidecar");
    }
}

fn cli_executable_name(target: &str) -> &'static str {
    if target.contains("windows") {
        "wmux-cli.exe"
    } else {
        "wmux-cli"
    }
}

fn sidecar_name(target: &str) -> String {
    if target.contains("windows") {
        format!("wmux-cli-{target}.exe")
    } else {
        format!("wmux-cli-{target}")
    }
}
