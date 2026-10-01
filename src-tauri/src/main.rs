// Windows 下不弹控制台窗口（release 构建）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 应用入口：窗口、全局热键、给前端的命令。
//!
//! 窗口是**无边框 + 置顶 + 不进任务栏 + 启动时隐藏**的悬浮层：热键呼出、Esc 或失焦收起，
//! 这是「查词器」该有的形态（不是常驻主窗口）。

mod mydict;

use std::path::PathBuf;

use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use mydict::{AppState, AuthStatus, Hit, PublicDict, Settings};

/// 默认热键。
///
/// 挑组合时踩过的坑，都写在这里免得下次再试：
/// - `Win+F`：Windows 的「反馈中心」占用
/// - `Alt+Space`：Linux/XFCE 的窗口操作菜单占用
/// - `Ctrl+Alt+F`：**是 Linux 切换虚拟控制台（VT）的组合键**，实测在这台机器上注册必然失败
///   （`HotKey already registered`）
///
/// 所以默认取 `super+shift+d`（Linux 上实测可用），设置里可改；注册失败时界面会明确报出来。
/// Windows 上 super 即 Win 键，Win 系组合易与系统撞车（Win+F 是反馈中心），取 `ctrl+alt+d`。
#[cfg(target_os = "linux")]
const DEFAULT_HOTKEY: &str = "super+shift+d";
#[cfg(target_os = "windows")]
const DEFAULT_HOTKEY: &str = "ctrl+alt+d";
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
const DEFAULT_HOTKEY: &str = "super+shift+d";

fn main() {
    tauri::Builder::default()
        // 单实例（必须第一个注册）：二次启动时这里先跑——把已有实例唤到前台，
        // 新进程随即退出。启动菜单/自启/热键外再点一次图标，不会再开出第二个托盘。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("popup") {
                let _ = window.show();
                app.state::<AppState>().set_window_visible(true);
                let _ = window.set_focus();
                let _ = app.emit_to("popup", "mydict:shown", ShownPayload { focused: true });
                eprintln!("[single-instance] 二次启动 → 已唤起现有实例");
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            // 自启时静默进托盘：不带 --show，窗口保持隐藏
            Some(vec!["--tray"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // 只在按下时动作：否则按下+抬起会切换两次
                    if event.state() == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let dir: PathBuf = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            let state = AppState::load(dir);
            let spec = state.settings().hotkey;
            app.manage(state);
            register_hotkey(app.handle(), &spec);
            // 托盘建不起来不该拖垮应用：热键与查词是主功能，托盘只是常驻入口
            if let Err(err) = build_tray(app.handle()) {
                eprintln!("[tray] 托盘构建失败（不影响热键与查词）：{err}");
            }
            start_clipboard_watch(app.handle().clone());
            // 远程探针：MYDICT_DEBUG_EVAL='document.title=…' 让 popup 执行一段 JS 并把结果
            // 写进窗口标题（GUI 里没有控制台，这是从外部看 DOM 状态的唯一通道）
            for (var_name, label) in [
                ("MYDICT_DEBUG_EVAL", "popup"),
                ("MYDICT_DEBUG_EVAL_MAIN", "main"),
            ] {
                if let Ok(js) = std::env::var(var_name) {
                    let handle = app.handle().clone();
                    let label = label.to_string();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(6000));
                        if let Some(w) = handle.get_webview_window(&label) {
                            let _ = w.eval(&js);
                            eprintln!("[debug] eval 已执行：{label}");
                        }
                    });
                }
            }
            // 调试开关 `--show`：启动就把窗口显示出来。热键被别的程序占用时（或没有 WM 的环境
            // 里）也能看界面、截图，不必先排除热键问题。
            if std::env::args().any(|arg| arg == "--show") {
                if let Some(window) = app.get_webview_window("popup") {
                    let _ = window.show();
                    let geometry = app.state::<AppState>().popup_geometry();
                    eprintln!("[show] popup_geometry={geometry:?}");
                    if let Some(geometry) = geometry {
                        // --show 调试路径同样恢复上一次的几何，与热键/剪贴板路径一致
                        let r1 = window
                            .set_size(tauri::PhysicalSize::new(geometry.width, geometry.height));
                        let r2 = window
                            .set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y));
                        eprintln!("[show] set_size={r1:?} set_position={r2:?}");
                    }
                    let _ = window.set_focus();
                    app.state::<AppState>().set_window_visible(true);
                    let _ = app.emit_to("popup", "mydict:shown", ShownPayload { focused: true });
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 快捷搜索窗的移动/缩放：记住上一次的尺寸与位置。拖动会连续触发事件，
            // 这里只记最新值并交给防抖线程，静止 600ms 后落盘一次。
            if window.label() != "popup" {
                return;
            }
            if !matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                return;
            }
            let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
                return;
            };
            let geometry = mydict::PopupGeometry {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            };
            let state = window.state::<AppState>();
            let generation = state.stage_popup_geometry(geometry);
            let handle = window.app_handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(600));
                handle
                    .state::<AppState>()
                    .persist_popup_geometry_if_current(generation);
            });
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            auth_status,
            login,
            logout,
            search,
            dictionaries,
            entry_html,
            hide_window,
            selection_text,
            note,
            open_main,
            focus_probe,
            hotkey_error,
            open_external,
            open_viewer,
            take_viewer_payload,
            close_viewer,
        ])
        .run(tauri::generate_context!())
        .expect("应用启动失败");
}

/// 常驻托盘：显示/隐藏、设置、开机自启（勾选）、退出；左键点图标 = 切换窗口。
///
/// Linux 上托盘走 StatusNotifier（XFCE 面板的 indicator 插件提供宿主），没有宿主时图标不显示，
/// 但不影响主功能——热键与 Esc 照旧可用。
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let toggle_item = MenuItem::with_id(app, "toggle", "快捷搜索（显示 / 隐藏）", true, None::<&str>)?;
    let main_item = MenuItem::with_id(app, "main", "词典主界面", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启",
        true,
        autostart_on,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle_item,
            &main_item,
            &PredefinedMenuItem::separator(app)?,
            &settings_item,
            &PredefinedMenuItem::separator(app)?,
            &autostart_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    // 图标显式来自内嵌 PNG：实测依赖「默认应用图标」时 `/run/user/<uid>/tray-icon` 里
    // 从未写入 PNG，面板只能显示占位破图。from_bytes 需要 tauri 的 image-png 特性（已开）。
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
        .map_err(|err| tauri::Error::AssetNotFound(format!("内嵌托盘图标解码失败：{err}")))?;
    let mut builder = TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("MyDict 查词")
        .menu(&menu)
        // 左键留给「切换窗口」，菜单只在右键弹（点击即显菜单会让托盘很吵）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            eprintln!("[menu] 触发：{id}");
            // 菜单 activate 回调跑在主线程（GTK）：在这里直接做窗口操作会与菜单的
            // deactivation 重入，实测会把 libappindicator 的菜单服务搞死——之后宿主
            // 再也弹不出菜单。全部动作派发到独立线程，回调立即返回。
            let app = app.clone();
            std::thread::spawn(move || match id.as_str() {
                "toggle" => toggle_window(&app),
                "main" => show_main(&app),
                "settings" => {
                    if let Some(window) = app.get_webview_window("popup") {
                        let _ = window.show();
                        app.state::<AppState>().set_window_visible(true);
                        let _ = app.emit_to("popup", "mydict:shown", ShownPayload { focused: true });
                        let _ = app.emit_to("popup", "mydict:open-settings", ());
                    }
                }
                "autostart" => {
                    let manager = app.autolaunch();
                    let now = manager.is_enabled().unwrap_or(false);
                    let result = if now { manager.disable() } else { manager.enable() };
                    if let Err(err) = result {
                        eprintln!("[tray] 切换开机自启失败：{err}");
                    }
                    let state = manager.is_enabled().unwrap_or(false);
                    app.state::<TrayState>().autostart_item.set_checked(state).ok();
                    eprintln!("[tray] 开机自启 = {state}");
                }
                "quit" => app.exit(0),
                _ => {}
            });
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = &event
            {
                eprintln!("[tray-icon] {button:?} {button_state:?}");
                if *button == MouseButton::Left && *button_state == MouseButtonState::Up {
                    let app = tray.app_handle().clone();
                    std::thread::spawn(move || toggle_window(&app));
                }
            }
        });

    // 勾选项的句柄要留着——改完自启状态得把菜单里的勾同步过来
    app.manage(TrayState {
        autostart_item: autostart_item.clone(),
    });
    builder.build(app)?;
    Ok(())
}

/// 托盘里需要留着的句柄
struct TrayState {
    autostart_item: CheckMenuItem<tauri::Wry>,
}

/// 注册（或重新注册）全局热键；失败原因记进状态，设置页要能看到——静默失败会让用户
/// 以为「热键没反应」，而那其实是「被别的软件占了」。
fn register_hotkey(app: &tauri::AppHandle, spec: &str) {
    let state = app.state::<AppState>();
    let _ = app.global_shortcut().unregister_all();
    match parse_hotkey(spec) {
        Ok(shortcut) => match app.global_shortcut().register(shortcut) {
            Ok(()) => {
                eprintln!("[hotkey] 注册成功：{spec}");
                state.set_hotkey_error(None);
            }
            Err(err) => state.set_hotkey_error(Some(format!("热键 {spec} 注册失败（可能被别的程序占用）：{err}"))),
        },
        Err(err) => state.set_hotkey_error(Some(err)),
    }
}

/// `ctrl+alt+f` / `Super+Shift+Space` 这类写法 → 插件的 Shortcut
fn parse_hotkey(spec: &str) -> Result<Shortcut, String> {
    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;
    for raw in spec.split('+') {
        let token = raw.trim().to_ascii_lowercase();
        if token.is_empty() {
            continue;
        }
        match token.as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "alt" | "option" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "super" | "meta" | "win" | "cmd" | "command" => mods |= Modifiers::SUPER,
            _ => {
                if code.is_some() {
                    return Err(format!("热键 {spec} 里只能有一个主键"));
                }
                code = Some(key_code(&token)?);
            }
        }
    }
    let code = code.ok_or_else(|| format!("热键 {spec} 缺少主键（如 ctrl+alt+f）"))?;
    let mods = if mods.is_empty() { None } else { Some(mods) };
    Ok(Shortcut::new(mods, code))
}

fn key_code(token: &str) -> Result<Code, String> {
    let code = match token {
        "space" => Code::Space,
        "enter" | "return" => Code::Enter,
        "tab" => Code::Tab,
        "escape" | "esc" => Code::Escape,
        "backspace" => Code::Backspace,
        "delete" => Code::Delete,
        "slash" => Code::Slash,
        "backslash" => Code::Backslash,
        "comma" => Code::Comma,
        "period" => Code::Period,
        "semicolon" => Code::Semicolon,
        "quote" => Code::Quote,
        "minus" => Code::Minus,
        "equal" => Code::Equal,
        "backquote" => Code::Backquote,
        "bracketleft" => Code::BracketLeft,
        "bracketright" => Code::BracketRight,
        single if single.len() == 1 => {
            let ch = single.chars().next().expect("len 1");
            match ch.to_ascii_uppercase() {
                'A' => Code::KeyA,
                'B' => Code::KeyB,
                'C' => Code::KeyC,
                'D' => Code::KeyD,
                'E' => Code::KeyE,
                'F' => Code::KeyF,
                'G' => Code::KeyG,
                'H' => Code::KeyH,
                'I' => Code::KeyI,
                'J' => Code::KeyJ,
                'K' => Code::KeyK,
                'L' => Code::KeyL,
                'M' => Code::KeyM,
                'N' => Code::KeyN,
                'O' => Code::KeyO,
                'P' => Code::KeyP,
                'Q' => Code::KeyQ,
                'R' => Code::KeyR,
                'S' => Code::KeyS,
                'T' => Code::KeyT,
                'U' => Code::KeyU,
                'V' => Code::KeyV,
                'W' => Code::KeyW,
                'X' => Code::KeyX,
                'Y' => Code::KeyY,
                'Z' => Code::KeyZ,
                '0' => Code::Digit0,
                '1' => Code::Digit1,
                '2' => Code::Digit2,
                '3' => Code::Digit3,
                '4' => Code::Digit4,
                '5' => Code::Digit5,
                '6' => Code::Digit6,
                '7' => Code::Digit7,
                '8' => Code::Digit8,
                '9' => Code::Digit9,
                other => return Err(format!("不认识的热键主键：{other}")),
            }
        }
        fkey if fkey.starts_with('f') && fkey[1..].parse::<u8>().is_ok() => {
            match fkey[1..].parse::<u8>().expect("已判定是数字") {
                1 => Code::F1,
                2 => Code::F2,
                3 => Code::F3,
                4 => Code::F4,
                5 => Code::F5,
                6 => Code::F6,
                7 => Code::F7,
                8 => Code::F8,
                9 => Code::F9,
                10 => Code::F10,
                11 => Code::F11,
                12 => Code::F12,
                other => return Err(format!("F{other} 还没支持，可用 F1–F12")),
            }
        }
        other => return Err(format!("不认识的热键主键：{other}")),
    };
    Ok(code)
}

/// 热键：可见就收起，不可见就呼出。
///
/// 呼出分两种模式：
/// - **划词模式**（`selection_first` 开着且系统里真有选中文字）：查那段文字，窗口**不抢焦点**，
///   不打断用户在原应用里的选区；
/// - **普通模式**：聚焦窗口并把光标放到输入框（由前端在 `mydict:shown` 里处理）。
///
/// 可见状态用 AppState 自己记账，**不能用 `is_visible()`**（X11/GTK 下它对无边框窗口恒为
/// false，实测踩到：窗口明明显示着，第二次按热键却仍走呼出分支、收不起来）。
fn toggle_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("popup") else {
        return;
    };
    let state = app.state::<AppState>();
    let visible = state.is_window_visible();
    if visible {
        eprintln!("[hotkey] 可见 → 收起");
        let _ = window.hide();
        state.set_window_visible(false);
        let _ = app.emit_to("popup", "mydict:hidden", ());
        return;
    }

    let settings = state.settings();
    let selected = if settings.selection_first {
        read_selection()
    } else {
        String::new()
    };
    let _ = window.show();
    // 用户拖过/缩放过就恢复上一次的几何；先 show 再定位（未映射窗口上定位会让
    // WebKitGTK 的输入区域失效）。从未动过才贴光标居中。
    match state.popup_geometry() {
        Some(geometry) => {
            let _ = window.set_size(tauri::PhysicalSize::new(geometry.width, geometry.height));
            let _ = window.set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y));
        }
        None => place_near_cursor(&window),
    }
    state.set_window_visible(true);
    eprintln!(
        "[hotkey] 呼出（{}）",
        if selected.is_empty() { "普通模式" } else { "划词模式" }
    );

    // 两种模式都聚焦输入框（前端收到 shown 后 focus+select）：用户要的是「呼出即可编辑」。
    // 曾经划词模式把焦点还给原窗口，结果 PRIMARY 里有陈旧选区时每次呼出都走划词、
    // 永远无法聚焦输入框（用户实测「激活快速面板没有聚焦搜索框」）。
    // XFCE 的「防焦点窃取」可能把刚拿到的焦点又还给上一个窗口，所以补一次。
    let _ = window.set_focus();
    let focus_window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let _ = focus_window.set_focus();
    });
    let _ = app.emit_to("popup", "mydict:shown", ShownPayload { focused: true });
    if !selected.is_empty() {
        let _ = app.emit_to("popup", "mydict:word", selected);
    }
}

/// 当前活动窗口的 X id（划词模式呼出前记下来，之后把焦点还回去）
#[cfg(all(unix, not(target_os = "macos")))]
fn active_window_id() -> Option<String> {
    let output = std::process::Command::new("xdotool")
        .arg("getactivewindow")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if id.is_empty() || id == "0" {
        None
    } else {
        Some(id)
    }
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn active_window_id() -> Option<String> {
    None
}

/// 打开词典主界面（重型浏览窗口）；若快捷搜索窗开着，让它让位
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        // 激活即聚焦搜索框并全选（前端处理）：随时可以改词重查
        let _ = app.emit_to("main", "mydict:main-shown", ());
    }
    if let Some(popup) = app.get_webview_window("popup") {
        let _ = popup.hide();
        app.state::<AppState>().set_window_visible(false);
    }
}

/// 剪贴板监听：轮询 CLIPBOARD，发现新的短文本就弹快捷搜索窗查词。
///
/// 用轮询而不是 X11 剪贴板事件：零额外依赖，700ms 的粒度对「复制→查词」足够；
/// 去重靠 last（连续相同的复制不重复触发），窗口已可见时只更新结果、不重新定位。
fn start_clipboard_watch(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(700));
            let (enabled, visible) = {
                let state = app.state::<AppState>();
                (state.settings().clipboard_watch, state.is_window_visible())
            };
            if !enabled {
                continue;
            }
            #[cfg(all(unix, not(target_os = "macos")))]
            let text = read_xclip("clipboard");
            #[cfg(not(all(unix, not(target_os = "macos"))))]
            let text = String::new();
            // 只认 ≤60 字的文本：更长的多半是整段内容，不是查词意图
            let trimmed = text.trim().to_string();
            if trimmed.is_empty() || trimmed.chars().count() > 60 || trimmed == last {
                continue;
            }
            last = trimmed.clone();
            if visible {
                let _ = app.emit_to("popup", "mydict:word", trimmed);
                continue;
            }
            if let Some(window) = app.get_webview_window("popup") {
                let _ = window.show();
                match app.state::<AppState>().popup_geometry() {
                    Some(geometry) => {
                        let _ = window
                            .set_size(tauri::PhysicalSize::new(geometry.width, geometry.height));
                        let _ = window
                            .set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y));
                    }
                    None => place_near_cursor(&window),
                }
                app.state::<AppState>().set_window_visible(true);
                let _ = app.emit_to("popup", "mydict:word", trimmed);
                let _ = app.emit_to("popup", "mydict:shown", ShownPayload { focused: false });
            }
        }
    });
}

/// 给前端的「窗口已显示」事件载荷
#[derive(Clone, serde::Serialize)]
struct ShownPayload {
    focused: bool,
}

/// 读当前选中文字（划词用）。
///
/// Linux/X11：先读 PRIMARY 选区（拖选即写入，不碰剪贴板），没有再看 CLIPBOARD。
/// 走 `xclip` 子进程而不是 X11 crate：少一个依赖、行为可预期（`xclip` 没选区时立刻退出）。
///
/// Windows：UIA 取选区（Electron/自绘文本取不到）或模拟 Ctrl+C + 剪贴板还原，M3 再做，
/// 这里先返回空串——即退化成「普通呼出」，不会出错。
#[cfg(all(unix, not(target_os = "macos")))]
fn read_selection() -> String {
    for selection in ["primary", "clipboard"] {
        let text = read_xclip(selection);
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

/// 读指定选区（X11）；无内容/无属主时返回空串
#[cfg(all(unix, not(target_os = "macos")))]
fn read_xclip(selection: &str) -> String {
    let Ok(output) = std::process::Command::new("xclip")
        .args(["-o", "-selection", selection])
        .output()
    else {
        return String::new();
    };
    if !output.status.success() {
        return String::new();
    }
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn read_xclip(_selection: &str) -> String {
    String::new()
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn read_selection() -> String {
    // TODO(M3)：Windows 走 UIA；macOS 走 AX API
    String::new()
}

/// 悬浮窗落在鼠标所在那块屏的中上部；拿不到鼠标位置就退回居中
fn place_near_cursor(window: &WebviewWindow) {
    let Ok(cursor) = window.cursor_position() else {
        let _ = window.center();
        return;
    };
    let Ok(Some(monitor)) = window.monitor_from_point(cursor.x, cursor.y) else {
        let _ = window.center();
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let screen = monitor.size();
    let origin = monitor.position();
    let x = origin.x + ((screen.width as i32 - size.width as i32) / 2).max(0);
    // 放在偏上位置（约 28% 高度处）：视线落点舒服，也留出下方看词条的空间
    let y = origin.y + (screen.height as f64 * 0.28) as i32;
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let state = app.state::<AppState>();
    let previous_hotkey = state.settings().hotkey;
    if parse_hotkey(&settings.hotkey).is_err() {
        // 先校验再落盘：否则写坏了下次启动热键就没了
        parse_hotkey(&settings.hotkey)?;
    }
    state.set_settings(settings.clone());
    // 广播给全部窗口：另一侧窗口里的 settings 副本（主题/服务器地址…）不用重启才生效
    let _ = app.emit("mydict:settings-updated", settings.clone());
    if settings.hotkey != previous_hotkey {
        register_hotkey(&app, &settings.hotkey);
    }
    Ok(())
}

#[tauri::command]
fn hotkey_error(state: tauri::State<'_, AppState>) -> Option<String> {
    state.hotkey_error()
}

#[tauri::command]
fn auth_status(state: tauri::State<'_, AppState>) -> AuthStatus {
    state.auth_status()
}

#[tauri::command]
async fn login(
    state: tauri::State<'_, AppState>,
    username: String,
    password: String,
) -> Result<(), String> {
    state.login(&username, &password).await
}

#[tauri::command]
fn logout(state: tauri::State<'_, AppState>) {
    state.logout();
}

#[tauri::command]
async fn search(
    state: tauri::State<'_, AppState>,
    word: String,
    dict_ids: Option<Vec<i64>>,
) -> Result<Vec<Hit>, String> {
    state
        .search(&word, dict_ids.as_deref())
        .await
}

#[tauri::command]
async fn dictionaries(
    state: tauri::State<'_, AppState>,
    scope: String,
) -> Result<Vec<PublicDict>, String> {
    state.dictionaries(&scope).await
}

#[tauri::command]
async fn entry_html(
    state: tauri::State<'_, AppState>,
    dictionary_id: i64,
    word: String,
    entry_ids: Vec<i64>,
    theme: Option<String>,
) -> Result<String, String> {
    state
        .entry_html(dictionary_id, &word, &entry_ids, theme.as_deref())
        .await
}

/// 焦点探针：返回「当前活动窗口」的 `id|名字`，供前端判断失焦是真离开还是幽灵事件。
///
/// 实测出现过无任何交互、呼出 18 秒后自己失焦的情况（X 层面把焦点交给了空窗口），
/// 于是失焦时先问一句：焦点落在哪儿？落在空 / 自己身上就不算用户离开。
#[tauri::command]
fn focus_probe() -> String {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let Some(id) = active_window_id() else {
            return "0|".to_string();
        };
        let name = std::process::Command::new("xdotool")
            .args(["getwindowname", &id])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        return format!("{id}|{name}");
    }
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    {
        "0|".to_string()
    }
}

/// 前端请求打开词典主界面（popup 的 ⧉ 按钮）。
/// 不用 JS 的 WebviewWindow.getByLabel：它对 Rust 配置里创建的窗口不一定可见。
#[tauri::command]
fn open_main(app: tauri::AppHandle) {
    show_main(&app);
}

/// 前端的诊断写入 stderr（GUI 里没有控制台，这个能把「谁触发了收起」这种线索留下来）
#[tauri::command]
fn note(tag: String) {
    eprintln!("[front] {tag}");
}

/// 词条图片查看器：新建一个**独立窗口**（无边框、置顶、铺满词条所在显示器），
/// 词典窗口保持原样——全屏看图不该顺带改词典窗口的几何。
///
/// 图片载荷走两条路：窗口新建时页面加载完调 take_viewer_payload 取暂存的初始载荷
/// （emit 可能早于页面监听装好，靠暂存避免竞态）；窗口已开着又点了别的图，直接
/// emit mydict:viewer-image 让它换图。
#[tauri::command]
fn open_viewer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    src: String,
    alt: String,
    urls: Vec<String>,
    index: usize,
) {
    let payload = mydict::ViewerPayload { src, alt, urls, index };
    if let Some(viewer) = app.get_webview_window("viewer") {
        let _ = viewer.set_focus();
        let _ = app.emit_to("viewer", "mydict:viewer-image", payload);
        return;
    }
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        eprintln!("[viewer] 创建查看器失败：拿不到显示器信息");
        return;
    };
    let origin = monitor.position();
    let bounds = monitor.size();
    let scale = monitor.scale_factor();
    app.state::<AppState>().stage_viewer_payload(payload);
    // builder 的 position/inner_size 都是逻辑单位，显示器几何是物理像素
    let result = tauri::WebviewWindowBuilder::new(
        &app,
        "viewer",
        tauri::WebviewUrl::App("viewer.html".into()),
    )
    .title("图片查看器")
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .position(origin.x as f64 / scale, origin.y as f64 / scale)
    .inner_size(bounds.width as f64 / scale, bounds.height as f64 / scale)
    .build();
    if let Err(err) = result {
        eprintln!("[viewer] 创建查看器窗口失败：{err}");
        // 别留下一个永远没人取的暂存载荷
        app.state::<AppState>().take_viewer_payload();
    } else {
        eprintln!(
            "[viewer] 打开 viewer {}x{}@{},{}",
            bounds.width, bounds.height, origin.x, origin.y
        );
    }
}

/// 查看器页面就绪后取初始图片载荷（取走即清）
#[tauri::command]
fn take_viewer_payload(app: tauri::AppHandle) -> Option<mydict::ViewerPayload> {
    app.state::<AppState>().take_viewer_payload()
}

/// 查看器里退出了（Esc/点空白），销毁窗口。popup/main 还在，应用不会跟着退出。
#[tauri::command]
fn close_viewer(app: tauri::AppHandle) {
    if let Some(viewer) = app.get_webview_window("viewer") {
        let _ = viewer.close();
    }
}

/// 读当前选中文字（前端在调试或将来做「划词快捷查」时可能要用）
#[tauri::command]
fn selection_text() -> String {
    read_selection()
}

/// 收起「发起调用的那个窗口」：popup 的 Esc/失焦收起走这里。
/// （之前写死隐藏 main——双窗口改造后 popup 永远收不起来，就是这一行。）
#[tauri::command]
fn hide_window(app: tauri::AppHandle, window: tauri::Window) {
    {
        let _ = window.hide();
        eprintln!("[hide] 前端请求收起");
        // 记账只对应 popup（热键/剪贴板的状态机针对它）；主界面的收起与此无关
        if window.label() == "popup" {
            app.state::<AppState>().set_window_visible(false);
        }
        let _ = app.emit_to("popup", "mydict:hidden", ());
    }
}

/// 词条里的外链（引导脚本把 `mydict:open` 交上来）交给系统浏览器
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("只允许打开 http(s) 链接".into());
    }
    open_url(&url).map_err(|e| format!("打开链接失败：{e}"))
}

#[cfg(target_os = "windows")]
fn open_url(url: &str) -> std::io::Result<()> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn open_url(url: &str) -> std::io::Result<()> {
    std::process::Command::new("open").arg(url).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_url(url: &str) -> std::io::Result<()> {
    std::process::Command::new("xdg-open").arg(url).spawn().map(|_| ())
}
