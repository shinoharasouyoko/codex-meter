mod cdp;
mod codex;
mod models;
mod weather;

use std::{
    fs,
    path::PathBuf,
    process::Child,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use models::{InjectorQuotaUpdate, InjectorWeatherUpdate};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

#[cfg(windows)]
use windows::Win32::{
    Foundation::COLORREF,
    UI::{
        Controls::Dialogs::{ChooseColorW, CC_FULLOPEN, CC_RGBINIT, CHOOSECOLORW},
        WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONERROR, MB_ICONQUESTION, MB_OK, MB_YESNO},
    },
};

const REFRESH_INTERVAL: Duration = Duration::from_secs(10);
const WEATHER_REFRESH_INTERVAL: Duration = Duration::from_secs(30 * 60);

struct AppState {
    client: reqwest::Client,
    quota_fetch_lock: tokio::sync::Mutex<()>,
    weather_fetch_lock: tokio::sync::Mutex<()>,
    injector_child: Mutex<Option<Child>>,
    font_color: Mutex<Option<String>>,
    restart_in_progress: AtomicBool,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct DisplayPreferences {
    font_color: Option<String>,
}

fn display_preferences_path() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("MyCoMeter").join("display.json"))
}

fn normalize_font_color(value: &str) -> Option<String> {
    let value = value.trim();
    let valid = value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit);
    valid.then(|| format!("#{}", value[1..].to_ascii_uppercase()))
}

fn load_font_color() -> Option<String> {
    let path = display_preferences_path()?;
    let source = fs::read_to_string(path).ok()?;
    let preferences: DisplayPreferences = serde_json::from_str(&source).ok()?;
    preferences
        .font_color
        .as_deref()
        .and_then(normalize_font_color)
}

fn save_font_color(color: Option<&str>) -> Result<(), String> {
    let path = display_preferences_path().ok_or("无法定位 MyCoMeter 配置目录")?;
    let parent = path.parent().ok_or("无效的 MyCoMeter 配置路径")?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录: {error}"))?;
    let preferences = DisplayPreferences {
        font_color: color.map(str::to_owned),
    };
    let content = serde_json::to_string(&preferences)
        .map_err(|error| format!("无法序列化显示配置: {error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存显示配置: {error}"))
}

#[cfg(windows)]
fn colorref_from_hex(color: Option<&str>) -> COLORREF {
    let color = color
        .and_then(normalize_font_color)
        .unwrap_or_else(|| "#FFFFFF".into());
    let red = u32::from_str_radix(&color[1..3], 16).unwrap_or(255);
    let green = u32::from_str_radix(&color[3..5], 16).unwrap_or(255);
    let blue = u32::from_str_radix(&color[5..7], 16).unwrap_or(255);
    COLORREF(red | (green << 8) | (blue << 16))
}

#[cfg(windows)]
fn choose_font_color(initial: Option<&str>) -> Option<String> {
    let mut custom_colors = [COLORREF::default(); 16];
    let mut dialog = CHOOSECOLORW {
        lStructSize: std::mem::size_of::<CHOOSECOLORW>() as u32,
        rgbResult: colorref_from_hex(initial),
        lpCustColors: custom_colors.as_mut_ptr(),
        Flags: CC_FULLOPEN | CC_RGBINIT,
        ..Default::default()
    };
    if !unsafe { ChooseColorW(&mut dialog) }.as_bool() {
        return None;
    }
    let value = dialog.rgbResult.0;
    Some(format!(
        "#{:02X}{:02X}{:02X}",
        value & 0xff,
        (value >> 8) & 0xff,
        (value >> 16) & 0xff
    ))
}

fn publish_font_color(app: &AppHandle, color: Option<String>) {
    let message = serde_json::json!({ "type": "fontColor", "color": color }).to_string();
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let result = state
        .injector_child
        .lock()
        .map_err(|_| "injector state is unavailable".to_string())
        .and_then(|mut child| cdp::send_injector_message(&mut child, &message));
    if let Err(error) = result {
        eprintln!("[display] failed to publish font color: {error}");
    }
}

async fn fetch_and_publish_quota(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    let _guard = state.quota_fetch_lock.lock().await;
    let snapshot = codex::fetch_snapshot(&state.client).await;
    let update = InjectorQuotaUpdate::from(&snapshot);
    let has_quota = snapshot.status == "ok"
        && (update.short_window.is_some() || update.weekly_window.is_some());
    let quota_message = match serde_json::to_string(&update) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[quota] failed to serialize update: {error}");
            return false;
        }
    };
    let sent = state
        .injector_child
        .lock()
        .map_err(|_| "injector state is unavailable".to_string())
        .and_then(|mut child| cdp::send_injector_message(&mut child, &quota_message));
    if let Err(error) = sent {
        eprintln!("[quota] failed to publish update: {error}");
        return false;
    }

    has_quota
}

async fn fetch_and_publish_weather(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    let _guard = state.weather_fetch_lock.lock().await;
    let weather_update = match weather::fetch_snapshot(&state.client).await {
        Ok(snapshot) => InjectorWeatherUpdate::from(&snapshot),
        Err(error) => {
            eprintln!("[weather] {error}");
            InjectorWeatherUpdate::unavailable()
        }
    };
    let weather_message = match serde_json::to_string(&weather_update) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[weather] failed to serialize update: {error}");
            return false;
        }
    };
    let sent = state
        .injector_child
        .lock()
        .map_err(|_| "injector state is unavailable".to_string())
        .and_then(|mut child| cdp::send_injector_message(&mut child, &weather_message));
    if let Err(error) = sent {
        eprintln!("[weather] failed to publish update: {error}");
        return false;
    }
    weather_update.status == "ok"
}

fn request_status_refresh(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tokio::join!(
            fetch_and_publish_quota(&app),
            fetch_and_publish_weather(&app)
        );
    });
}

fn start_quota_refresh_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = fetch_and_publish_quota(&app).await;
            tokio::time::sleep(REFRESH_INTERVAL).await;
        }
    });
}

fn start_weather_refresh_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = fetch_and_publish_weather(&app).await;
            tokio::time::sleep(WEATHER_REFRESH_INTERVAL).await;
        }
    });
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let refresh = MenuItem::with_id(app, "refresh", "立即刷新用量和天气", true, None::<&str>)?;
    let restart_codex = MenuItem::with_id(app, "restart_codex", "重启 Codex", true, None::<&str>)?;
    let font_color = MenuItem::with_id(app, "font_color", "设置电量字体颜色…", true, None::<&str>)?;
    let reset_font_color = MenuItem::with_id(
        app,
        "reset_font_color",
        "恢复默认电量字体颜色",
        true,
        None::<&str>,
    )?;
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机启动",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &refresh,
            &restart_codex,
            &font_color,
            &reset_font_color,
            &autostart,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        // Windows shows the hidden-icons flyout on the taskbar. Keeping the
        // native menu on right click only avoids competing with that flyout
        // when the user selects the tray icon with the left button.
        .show_menu_on_left_click(false)
        .tooltip("MyCoMeter");
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let autostart_menu = autostart.clone();
    let restart_menu = restart_codex.clone();
    builder
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "refresh" => request_status_refresh(app),
            "restart_codex" => request_codex_restart(app, &restart_menu),
            "font_color" => {
                let initial = app
                    .try_state::<AppState>()
                    .and_then(|state| state.font_color.lock().ok().and_then(|color| color.clone()));
                #[cfg(windows)]
                if let Some(color) = choose_font_color(initial.as_deref()) {
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Ok(mut stored) = state.font_color.lock() {
                            *stored = Some(color.clone());
                        }
                    }
                    if let Err(error) = save_font_color(Some(&color)) {
                        eprintln!("[display] failed to save font color: {error}");
                    }
                    publish_font_color(app, Some(color));
                }
            }
            "reset_font_color" => {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut stored) = state.font_color.lock() {
                        *stored = None;
                    }
                }
                if let Err(error) = save_font_color(None) {
                    eprintln!("[display] failed to reset font color: {error}");
                }
                publish_font_color(app, None);
            }
            "autostart" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let result = if enabled {
                    manager.disable()
                } else {
                    manager.enable()
                };
                match result {
                    Ok(()) => {
                        let _ = autostart_menu.set_checked(!enabled);
                    }
                    Err(error) => eprintln!("autostart update failed: {error}"),
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn attach_injector(app: &AppHandle, session: &cdp::CdpSession) -> Result<(), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "MyCoMeter state is unavailable".to_string())?;
    let font_color = state
        .font_color
        .lock()
        .map_err(|_| "font color state is unavailable".to_string())?
        .clone();
    let node_exe = cdp::find_node_exe()?;
    let injector_mjs = cdp::resolve_injector_mjs()?;
    let mut child = Some(cdp::spawn_injector(
        &node_exe,
        &injector_mjs,
        session.port,
        &session.browser_id,
    )?);
    let result = state
        .injector_child
        .lock()
        .map_err(|_| "injector state is unavailable".to_string())
        .map(|mut injector| {
            *injector = child.take();
        });
    if let Err(error) = result {
        cdp::kill_injector(&mut child);
        return Err(error);
    }
    publish_font_color(app, font_color);
    eprintln!(
        "[cdp] injector started (port={}, browser-id={}, strategy={})",
        session.port, session.browser_id, session.strategy
    );
    Ok(())
}

#[cfg(windows)]
fn confirm_codex_restart() -> bool {
    let text: Vec<u16> =
        "重启 Codex 将关闭当前窗口并重新打开，正在执行的操作可能被中断。\n\n是否继续？"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
    let caption: Vec<u16> = "MyCoMeter"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MessageBoxW(
            None,
            windows::core::PCWSTR(text.as_ptr()),
            windows::core::PCWSTR(caption.as_ptr()),
            MB_YESNO | MB_ICONQUESTION,
        )
    };
    result == IDYES
}

#[cfg(windows)]
fn report_codex_restart_error(error: &str) {
    let text: Vec<u16> = format!("重启 Codex 失败：{error}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let caption: Vec<u16> = "MyCoMeter"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let _ = MessageBoxW(
            None,
            windows::core::PCWSTR(text.as_ptr()),
            windows::core::PCWSTR(caption.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
}

fn restart_codex(app: &AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "MyCoMeter state is unavailable".to_string())?;
    if let Ok(mut injector) = state.injector_child.lock() {
        cdp::kill_injector(&mut injector);
    } else {
        return Err("injector state is unavailable".to_string());
    }

    let session = cdp::restart_codex_cdp(cdp::DEFAULT_CDP_PORT)?;
    attach_injector(app, &session)?;
    request_status_refresh(app);
    Ok(())
}

#[cfg(windows)]
fn request_codex_restart(app: &AppHandle, restart_menu: &MenuItem<tauri::Wry>) {
    if !confirm_codex_restart() {
        return;
    }
    let Some(state) = app.try_state::<AppState>() else {
        report_codex_restart_error("MyCoMeter state is unavailable");
        return;
    };
    if state.restart_in_progress.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = restart_menu.set_enabled(false);
    let worker_app = app.clone();
    let callback_app = app.clone();
    let restart_menu = restart_menu.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || restart_codex(&worker_app)).await;
        if let Some(state) = callback_app.try_state::<AppState>() {
            state.restart_in_progress.store(false, Ordering::Release);
        }
        let _ = restart_menu.set_enabled(true);
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => report_codex_restart_error(&error),
            Err(error) => report_codex_restart_error(&format!("后台任务失败：{error}")),
        }
    });
}

#[cfg(not(windows))]
fn request_codex_restart(_app: &AppHandle, _restart_menu: &MenuItem<tauri::Wry>) {
    eprintln!("[cdp] Codex restart is only supported on Windows");
}

/// Initialize the verified local CDP connection and injector process.
fn init_cdp(app: &AppHandle) -> bool {
    let preferred_port = cdp::DEFAULT_CDP_PORT;

    let session = match cdp::ensure_codex_cdp(preferred_port, false) {
        Ok(session) => session,
        Err(probe_error) => {
            eprintln!("[cdp] no reusable CDP: {probe_error}");
            #[cfg(windows)]
            {
                // On startup a missing CDP listener simply means Codex was
                // launched without debug flags. Restart it silently so
                // autostart never blocks behind a confirmation dialog.
            }
            #[cfg(not(windows))]
            {
                eprintln!("[cdp] automatic Codex restart is only supported on Windows");
                app.exit(0);
                return false;
            }

            match cdp::ensure_codex_cdp(preferred_port, true) {
                Ok(session) => session,
                Err(error) => {
                    eprintln!("[cdp] {error}");
                    app.exit(0);
                    return false;
                }
            }
        }
    };

    if let Err(error) = attach_injector(app, &session) {
        eprintln!("[cdp] {error}");
        return false;
    }
    true
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            request_status_refresh(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(12))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("MyCoMeter/0.4.7")
                .build()
                .expect("static HTTP client configuration must be valid");
            app.manage(AppState {
                client,
                quota_fetch_lock: tokio::sync::Mutex::new(()),
                weather_fetch_lock: tokio::sync::Mutex::new(()),
                injector_child: Mutex::new(None),
                font_color: Mutex::new(load_font_color()),
                restart_in_progress: AtomicBool::new(false),
            });
            setup_tray(app)?;
            if init_cdp(app.handle()) {
                start_quota_refresh_loop(app.handle().clone());
                start_weather_refresh_loop(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build MyCoMeter");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<AppState>() {
                if let Ok(mut child) = state.injector_child.lock() {
                    cdp::kill_injector(&mut child);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_only_six_digit_hex_font_colors() {
        assert_eq!(normalize_font_color(" #aBc123 "), Some("#ABC123".into()));
        assert_eq!(normalize_font_color("#FFF"), None);
        assert_eq!(normalize_font_color("rgb(255, 255, 255)"), None);
        assert_eq!(normalize_font_color("#ABC12G"), None);
    }

    #[test]
    fn refreshes_quota_every_ten_seconds_and_weather_every_thirty_minutes() {
        assert_eq!(REFRESH_INTERVAL, Duration::from_secs(10));
        assert_eq!(WEATHER_REFRESH_INTERVAL, Duration::from_secs(30 * 60));
    }
}
