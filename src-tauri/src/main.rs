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

use mydict::{AppState, AuthStatus, Hit, Settings};

/// 默认热键。
///
/// 挑组合时踩过的坑，都写在这里免得下次再试：
/// - `Win+F`：Windows 的「反馈中心」占用
/// - `Alt+Space`：Linux/XFCE 的窗口操作菜单占用
/// - `Ctrl+Alt+F`：**是 Linux 切换虚拟控制台（VT）的组合键**，实测在这台机器上注册必然失败
///   （`HotKey already registered`）
///
/// 所以默认取 `super+shift+d`（Linux 上实测可用），设置里可改；注册失败时界面会明确报出来。
const DEFAULT_HOTKEY: &str = "super+shift+d";

fn main() {
    tauri::Builder::default()
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
            // 调试开关 `--show`：启动就把窗口显示出来。热键被别的程序占用时（或没有 WM 的环境
            // 里）也能看界面、截图，不必先排除热键问题。
            if std::env::args().any(|arg| arg == "--show") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    app.state::<AppState>().set_window_visible(true);
                    let _ = app.emit("mydict:shown", ShownPayload { focused: true });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            auth_status,
            login,
            logout,
            search,
            entry_html,
            hide_window,
            selection_text,
            note,
            focus_probe,
            hotkey_error,
            open_external,
        ])
        .run(tauri::generate_context!())
        .expect("应用启动失败");
}

/// 注册（或重新注册）全局热键；失败原因记进状态，设置页要能看到——静默失败会让用户
/// 以为「热键没反应」，而那其实是「被别的软件占了」。
fn register_hotkey(app: &tauri::AppHandle, spec: &str) {
    let state = app.state::<AppState>();
    let _ = app.global_shortcut().unregister_all();
    match parse_hotkey(spec) {
        Ok(shortcut) => match app.global_shortcut().register(shortcut) {
            Ok(()) => state.set_hotkey_error(None),
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
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let state = app.state::<AppState>();
    let visible = state.is_window_visible();
    if visible {
        eprintln!("[hotkey] 可见 → 收起");
        let _ = window.hide();
        state.set_window_visible(false);
        let _ = app.emit("mydict:hidden", ());
        return;
    }

    let settings = state.settings();
    let selected = if settings.selection_first {
        read_selection()
    } else {
        String::new()
    };
    // 划词模式下要把焦点还给用户原来的窗口：X11 的 WM 在 map 新窗口时会自动聚焦，
    // 光是不调 set_focus() 不够——得记住原活动窗口、呼出后再还回去。
    let previous_active = if selected.is_empty() { None } else { active_window_id() };
    place_near_cursor(&window);
    let _ = window.show();
    state.set_window_visible(true);
    eprintln!(
        "[hotkey] 呼出（{}）",
        if selected.is_empty() { "普通模式" } else { "划词模式" }
    );

    if selected.is_empty() {
        // 普通呼出：抢焦点（前端收到 focused=true 后会把光标放进输入框）。
        // XFCE 的「防焦点窃取」可能把刚拿到的焦点又还给上一个窗口，所以补一次——
        // 不然前端会看到「刚聚焦就失焦」，把它当成用户离开而立刻收起。
        let _ = window.set_focus();
        let focus_window = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let _ = focus_window.set_focus();
        });
        let _ = app.emit("mydict:shown", ShownPayload { focused: true });
    } else {
        // 划词：只展示不抢焦点。前端收到 focused=false 就不会武装「失焦收起」，
        // 也不会去动输入框焦点。
        if let Some(id) = previous_active.clone() {
            hand_focus_back(&id);
            // WM 的 map/聚焦是异步的：立刻还一次之后再补一次，确保最终焦点落在用户原来的窗口上
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(160));
                hand_focus_back(&id);
            });
        }
        let _ = app.emit("mydict:word", selected);
        let _ = app.emit("mydict:shown", ShownPayload { focused: false });
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

/// 把键盘焦点还给指定窗口（`windowfocus` 只改焦点、不抬升窗口，我们的悬浮层仍在最上）
#[cfg(all(unix, not(target_os = "macos")))]
fn hand_focus_back(window_id: &str) {
    let _ = std::process::Command::new("xdotool")
        .args(["windowfocus", "--sync", window_id])
        .output();
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn hand_focus_back(_window_id: &str) {}

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
        if let Ok(output) = std::process::Command::new("xclip")
            .args(["-o", "-selection", selection])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !text.is_empty() {
                    return text;
                }
            }
        }
    }
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
async fn search(state: tauri::State<'_, AppState>, word: String) -> Result<Vec<Hit>, String> {
    state.search(&word).await
}

#[tauri::command]
async fn entry_html(
    state: tauri::State<'_, AppState>,
    dictionary_id: i64,
    word: String,
    entry_ids: Vec<i64>,
) -> Result<String, String> {
    state.entry_html(dictionary_id, &word, &entry_ids).await
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

/// 前端的诊断写入 stderr（GUI 里没有控制台，这个能把「谁触发了收起」这种线索留下来）
#[tauri::command]
fn note(tag: String) {
    eprintln!("[front] {tag}");
}

/// 读当前选中文字（前端在调试或将来做「划词快捷查」时可能要用）
#[tauri::command]
fn selection_text() -> String {
    read_selection()
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        eprintln!("[hide] 前端请求收起");
        // 同步记账：否则下一次热键会以为「已经可见」而只做 hide（表现为按了没反应）
        app.state::<AppState>().set_window_visible(false);
        let _ = app.emit("mydict:hidden", ());
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
