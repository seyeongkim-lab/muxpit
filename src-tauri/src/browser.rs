use serde::Serialize;
use serde_json::Value;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

const EVAL_TIMEOUT: Duration = Duration::from_secs(5);
const BROWSER_INIT_SCRIPT: &str = r#"
(() => {
  const logs = [];
  Object.defineProperty(window, "__wmuxBrowserLogs", { value: logs, configurable: false });
  const record = (level, values) => {
    const message = values.map((value) => {
      if (typeof value === "string") return value;
      try { return JSON.stringify(value); } catch (_) { return String(value); }
    }).join(" ").slice(0, 4096);
    logs.push({ level, message, timestamp: Date.now() });
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...values) => {
      record(level, values);
      original(...values);
    };
  }
  window.addEventListener("error", (event) => record("error", [event.message]));
  window.addEventListener("unhandledrejection", (event) => record("error", [String(event.reason)]));
})();
"#;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNavigated {
    label: String,
    url: String,
}

#[derive(Debug, Serialize)]
pub struct BrowserUrl {
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshot {
    pub url: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
}

pub fn parse_browser_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid browser URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Browser URL must use http or https".to_string());
    }
    Ok(url)
}

fn validate_label(label: &str) -> Result<(), String> {
    if !label.starts_with("wmux-browser-")
        || label.len() > 160
        || !label
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | ':'))
    {
        return Err("Invalid browser label".to_string());
    }
    Ok(())
}

fn logical_bounds(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(LogicalPosition<f64>, LogicalSize<f64>), String> {
    if ![x, y, width, height].iter().all(|value| value.is_finite())
        || width < 1.0
        || height < 1.0
        || width > 100_000.0
        || height > 100_000.0
    {
        return Err("Invalid browser bounds".to_string());
    }
    Ok((LogicalPosition::new(x, y), LogicalSize::new(width, height)))
}

fn browser_webview(app: &AppHandle, label: &str) -> Result<Webview, String> {
    validate_label(label)?;
    app.get_webview(label)
        .ok_or_else(|| "Browser webview is not ready".to_string())
}

#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<BrowserUrl, String> {
    validate_label(&label)?;
    let url = parse_browser_url(&url)?;
    let (position, size) = logical_bounds(x, y, width, height)?;
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_position(position)
            .map_err(|error| error.to_string())?;
        webview.set_size(size).map_err(|error| error.to_string())?;
        webview.show().map_err(|error| error.to_string())?;
        return Ok(BrowserUrl {
            url: webview
                .url()
                .map_err(|error| error.to_string())?
                .to_string(),
        });
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window is not ready".to_string())?;
    let event_app = app.clone();
    let event_label = label.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url.clone()))
        .initialization_script(BROWSER_INIT_SCRIPT)
        .devtools(cfg!(debug_assertions))
        .on_navigation(|candidate| matches!(candidate.scheme(), "http" | "https"))
        .on_page_load(move |_webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let _ = event_app.emit_to(
                "main",
                "wmux-browser-navigated",
                BrowserNavigated {
                    label: event_label.clone(),
                    url: payload.url().to_string(),
                },
            );
        });
    window
        .add_child(builder, position, size)
        .map_err(|error| error.to_string())?;
    Ok(BrowserUrl {
        url: url.to_string(),
    })
}

#[tauri::command]
pub fn browser_update_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = browser_webview(&app, &label)?;
    let (position, size) = logical_bounds(x, y, width, height)?;
    webview
        .set_position(position)
        .map_err(|error| error.to_string())?;
    webview.set_size(size).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_set_visible(app: AppHandle, label: String, visible: bool) -> Result<(), String> {
    let webview = browser_webview(&app, &label)?;
    if visible {
        webview.show()
    } else {
        webview.hide()
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    validate_label(&label)?;
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<BrowserUrl, String> {
    let webview = browser_webview(&app, &label)?;
    let url = parse_browser_url(&url)?;
    webview
        .navigate(url.clone())
        .map_err(|error| error.to_string())?;
    Ok(BrowserUrl {
        url: url.to_string(),
    })
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, label: String) -> Result<BrowserUrl, String> {
    let webview = browser_webview(&app, &label)?;
    webview.reload().map_err(|error| error.to_string())?;
    Ok(BrowserUrl {
        url: webview
            .url()
            .map_err(|error| error.to_string())?
            .to_string(),
    })
}

#[tauri::command]
pub fn browser_current_url(app: AppHandle, label: String) -> Result<BrowserUrl, String> {
    let webview = browser_webview(&app, &label)?;
    Ok(BrowserUrl {
        url: webview
            .url()
            .map_err(|error| error.to_string())?
            .to_string(),
    })
}

async fn evaluate_json(webview: &Webview, script: &str) -> Result<Value, String> {
    let (sender, receiver) = mpsc::channel();
    webview
        .eval_with_callback(script, move |result| {
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(EVAL_TIMEOUT))
        .await
        .map_err(|error| format!("Browser evaluation task failed: {error}"))?
        .map_err(|_| "Browser evaluation timed out".to_string())?;
    serde_json::from_str(&result)
        .map_err(|error| format!("Invalid browser evaluation result: {error}"))
}

#[tauri::command]
pub async fn browser_snapshot(app: AppHandle, label: String) -> Result<Value, String> {
    let webview = browser_webview(&app, &label)?;
    evaluate_json(
        &webview,
        r#"(() => ({
          title: document.title || "",
          url: location.href,
          text: (document.body?.innerText || "").slice(0, 32768)
        }))()"#,
    )
    .await
}

#[tauri::command]
pub async fn browser_console_logs(app: AppHandle, label: String) -> Result<Value, String> {
    let webview = browser_webview(&app, &label)?;
    evaluate_json(
        &webview,
        r#"(() => ({
          url: location.href,
          logs: Array.isArray(window.__wmuxBrowserLogs) ? window.__wmuxBrowserLogs.slice() : []
        }))()"#,
    )
    .await
}

#[tauri::command]
pub fn browser_screenshot(app: AppHandle, label: String) -> Result<BrowserScreenshot, String> {
    let webview = browser_webview(&app, &label)?;
    browser_screenshot_impl(&webview)
}

#[cfg(target_os = "macos")]
fn browser_screenshot_impl(webview: &Webview) -> Result<BrowserScreenshot, String> {
    let position = webview.position().map_err(|error| error.to_string())?;
    let size = webview.size().map_err(|error| error.to_string())?;
    let window_position = webview
        .window()
        .inner_position()
        .map_err(|error| error.to_string())?;
    let x = window_position.x + position.x;
    let y = window_position.y + position.y;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let path = std::env::temp_dir().join(format!("wmux-browser-{timestamp}.png"));
    let rectangle = format!("{x},{y},{},{}", size.width, size.height);
    let output = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg("-tpng")
        .arg(format!("-R{rectangle}"))
        .arg(&path)
        .output()
        .map_err(|error| format!("Failed to start screen capture: {error}"))?;
    if !output.status.success() {
        return Err("Screen capture failed; grant wmux Screen Recording permission".to_string());
    }
    Ok(BrowserScreenshot {
        url: webview
            .url()
            .map_err(|error| error.to_string())?
            .to_string(),
        path: path.display().to_string(),
        width: size.width,
        height: size.height,
    })
}

#[cfg(not(target_os = "macos"))]
fn browser_screenshot_impl(_webview: &Webview) -> Result<BrowserScreenshot, String> {
    Err("Browser screenshots are currently supported on macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_url_accepts_http_and_https() {
        assert!(parse_browser_url("https://example.com/docs").is_ok());
        assert!(parse_browser_url("http://127.0.0.1:3000").is_ok());
    }

    #[test]
    fn browser_url_rejects_privileged_schemes() {
        assert!(parse_browser_url("file:///etc/passwd").is_err());
        assert!(parse_browser_url("javascript:alert(1)").is_err());
        assert!(parse_browser_url("data:text/html,test").is_err());
    }

    #[test]
    fn browser_labels_are_namespaced() {
        assert!(validate_label("wmux-browser-n-123").is_ok());
        assert!(validate_label("main").is_err());
        assert!(validate_label("wmux-browser-bad label").is_err());
    }

    #[test]
    fn browser_bounds_reject_zero_and_non_finite_values() {
        assert!(logical_bounds(10.0, 20.0, 800.0, 600.0).is_ok());
        assert!(logical_bounds(10.0, 20.0, 0.0, 600.0).is_err());
        assert!(logical_bounds(f64::NAN, 20.0, 800.0, 600.0).is_err());
    }
}
