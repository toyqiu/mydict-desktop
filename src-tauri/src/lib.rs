//! 应用主体（桌面 + Android 共用）。
//!
//! 桌面形态：无边框 + 置顶 + 不进任务栏 + 启动隐藏的悬浮层（热键呼出、Esc/失焦收起），
//! 外加托盘、全局热键、剪贴板监听、独立图片查看器窗口。
//!
//! Android 形态（M0）：单窗口 + 同一套 API 命令；桌面专属能力（热键/托盘/剪贴板/多窗口）
//! 全部用 `#[cfg(desktop)]` 门控掉，Android 侧只保留 HTTP 命令与词条渲染链路。

mod mydict;

use std::path::PathBuf;

use tauri::{Emitter, Manager};

use mydict::{AppState, AuthStatus, Hit, PublicDict, Settings};

/// 本地测试默认值：**仅 debug 构建**读取 `dev.defaults.json`（gitignore，编译期由 build.rs
/// 读入 OUT_DIR）。用来省掉「每装一次测试版就重填服务器/账号」的麻烦；发布版根本不编译
/// 这个模块，天然「剥离」——要连凭据一起发布，删掉该文件重新构建即可。
#[cfg(debug_assertions)]
mod dev {
    use crate::mydict::{AppState, Settings};

    include!(concat!(env!("OUT_DIR"), "/dev_defaults.rs"));

    /// (server_url, username, password)；server_url 为空视为未配置
    fn defaults() -> Option<(String, String, String)> {
        let raw: serde_json::Value = serde_json::from_str(DEV_DEFAULTS_JSON).ok()?;
        let field = |k: &str| {
            raw.get(k)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        let (url, user, pass) = (field("server_url"), field("username"), field("password"));
        if url.is_empty() {
            return None;
        }
        Some((url, user, pass))
    }

    /// 用默认值补全「用户还没填」的字段（不覆盖已有配置）
    pub fn apply_to_settings(current: &mut Settings) {
        if let Some((url, user, _)) = defaults() {
            if current.server_url.trim().is_empty() {
                current.server_url = url;
            }
            if current.username.trim().is_empty() {
                current.username = user;
            }
        }
    }

    /// 未登录且默认值里带了账号密码 → 静默登录一次（失败静默，回落到手动登录）
    pub async fn ensure_login(state: &AppState) {
        let Some((_, user, pass)) = defaults() else {
            return;
        };
        if user.is_empty() || pass.is_empty() || state.auth_status().logged_in {
            return;
        }
        let _ = state.login(&user, &pass).await;
    }
}

/// 加载配置：debug 构建顺带把本地测试默认值补进「空字段」（release 只做原样加载）
fn load_state(dir: PathBuf) -> AppState {
    let state = AppState::load(dir);
    #[cfg(debug_assertions)]
    {
        let mut settings = state.settings();
        dev::apply_to_settings(&mut settings);
        state.set_settings(settings);
    }
    state
}

#[cfg(desktop)]
use tauri::WebviewWindow;
#[cfg(desktop)]
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 默认热键（桌面端）。
///
/// 挑组合时踩过的坑，都写在这里免得下次再试：
/// - `Win+F`：Windows 的「反馈中心」占用
/// - `Alt+Space`：Linux/XFCE 的窗口操作菜单占用
/// - `Ctrl+Alt+F`：**是 Linux 切换虚拟控制台（VT）的组合键**，实测注册必然失败
///
/// 所以默认取 `super+shift+d`（Linux 实测可用）；Windows 上 super 即 Win 键，取 `ctrl+alt+d`。
/// 移动端没有全局热键，这个常量只用于配置结构的默认值（`mydict.rs` 引用它）。
#[cfg(target_os = "windows")]
const DEFAULT_HOTKEY: &str = "ctrl+alt+d";
#[cfg(not(target_os = "windows"))]
const DEFAULT_HOTKEY: &str = "super+shift+d";

/// Windows 11：让 DWM 把窗口按圆角处理——系统阴影沿圆角轮廓绘制，圆角外不再有
/// 方形阴影/像素残留（CSS 圆角与系统圆角之间的缝隙是透明网页内容，透出桌面）。
/// Win10 不支持该属性（调用无效果），保持方形阴影的旧行为。
#[cfg(target_os = "windows")]
fn set_dwm_rounded_corners(hwnd: isize) {
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attr: u32, value: *const u32, size: u32) -> i32;
    }
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;
    unsafe {
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &DWMWCP_ROUND, 4);
    }
}

/// 翻译：Edge 免 key 接口（无鉴权）。body 是裸 JSON 字符串数组；UA 必须伪装 Edge
/// 否则可能 403。与词典链路互不依赖——MyDict 不可达时翻译照常工作。
#[tauri::command]
async fn translate(
    texts: Vec<String>,
    from: Option<String>,
    to: String,
) -> Result<Vec<String>, String> {
    let mut url = format!(
        "https://edge.microsoft.com/translate/translatetext?to={}&isEnterpriseClient=false",
        mydict::urlencode(&to)
    );
    if let Some(f) = from.as_deref() {
        if f != "auto" && !f.is_empty() {
            url.push_str(&format!("&from={}", mydict::urlencode(f)));
        }
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
        )
        .json(&texts)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("网络失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("翻译服务 HTTP {status}"));
    }
    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(data
        .as_array()
        .map(|a| {
            a.iter()
                .map(|it| {
                    it["translations"][0]["text"]
                        .as_str()
                        .unwrap_or("")
                        .to_string()
                })
                .collect()
        })
        .unwrap_or_default())
}

/// 在线词典（Wikipedia/Wiktionary/百度百科聚合，服务端纯文本化 + 600s 缓存）。
///
/// 403 的语义是「服务端 online_dict_enabled 未开启」而不是鉴权失败——错误串以
/// `UNSUPPORTED:` 前缀开头，前端据此显示「未开启」文案。
#[tauri::command]
async fn online_lookup(
    server_url: String,
    token: Option<String>,
    word: String,
    lang: String,
) -> Result<serde_json::Value, String> {
    let url = format!(
        "{}/api/dict/online/lookup?word={}&lang={}",
        server_url.trim_end_matches('/'),
        mydict::urlencode(&word),
        mydict::urlencode(&lang)
    );
    let mut req = reqwest::Client::new()
        .get(&url)
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(15));
    if let Some(t) = token.as_deref() {
        if !t.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", t));
        }
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err("UNSUPPORTED:在线词典未开启（MyDict 管理后台 → 系统设置）".into());
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status));
    }
    Ok(body)
}

/// 读系统剪贴板文本（Android 上要求应用处于前台，系统才允许读取；失败一律按空串处理）。
/// 移动端用它实现「打开/回到前台时把剪贴板里的词预填进搜索框」。
///
/// 名字不能叫 `read_clipboard_text`：桌面（Windows）那份剪贴板轮询用的 helper 就叫这个名字，
/// 在 Windows 目标上会与命令重名（E0428）——本地 Linux/Android 因 helper 被 cfg 掉而查不出来。
#[tauri::command]
fn clipboard_text(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .read_text()
        .map(|t| t.trim().to_string())
        .map_err(|e| e.to_string())
}

/// 取走「系统分享进来」的文本：Kotlin 侧（MainActivity 的 onCreate/onNewIntent）把
/// ACTION_SEND 的文本写进 `app_data_dir()/shared_text.txt`，这里读取并删除（取走即清，
/// 避免下次冷启动重复查询）。
///
/// Android 路径换算（见 tauri 的 path/android.rs）：`app_data_dir()` 的默认值就是
/// `getDataDir` = `Context.dataDir`，**不拼 identifier**（拼 identifier 是桌面端的行为）。
/// 所以 Kotlin 侧写 `File(filesDir.parentFile, "shared_text.txt")` 即同一位置。
#[tauri::command]
fn take_shared_text(app: tauri::AppHandle) -> Option<String> {
    let path = app.path().app_data_dir().ok()?.join("shared_text.txt");
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// 启动期诊断日志：写到 {config_dir}/com.toyqiu.mydict.desktop/debug.log。
///
/// Windows release 的 stderr 是无效句柄（windows_subsystem="windows"），eprintln! 与
/// panic 信息全部丢失——「双击图标没反应、任务管理器没进程」这类启动期问题必须靠
/// 文件日志定位。crate::startup_log 在拿到 app_config_dir 之前也能用（自行拼路径）。
/// 在 Builder 启动前就要用（state 提前 manage，见 run），不能依赖 app handle。
fn manual_app_config_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA").map(PathBuf::from);
    #[cfg(not(target_os = "windows"))]
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|h| PathBuf::from(h).join(".config")));
    base.unwrap_or_else(|_| PathBuf::from("."))
        .join("com.toyqiu.mydict.desktop")
}

pub(crate) fn startup_log(msg: &str) {
    use std::io::Write;
    // 统一写配置目录（Windows=APPDATA，Linux=XDG/HOME/.config）——与启动方式无关，
    // 否则菜单/图标启动的实例 stderr 落不到同一个日志，诊断信息直接丢失
    let dir = manual_app_config_dir();
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if std::fs::create_dir_all(&dir).is_ok() {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("debug.log"))
        {
            let _ = writeln!(f, "{millis} {msg}");
        }
    }
}

/// 应用入口：桌面与 Android 共用（Android 侧由 `mobile_entry_point` 调用）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    {
        startup_log(&format!(
            "main() 进入 v{}（本次启动属于这个版本的二进制）",
            env!("CARGO_PKG_VERSION")
        ));
        std::panic::set_hook(Box::new(|info| {
            let bt = std::backtrace::Backtrace::force_capture();
            startup_log(&format!("[panic] {info}\n[backtrace] {bt}"));
        }));
    }

    let mut builder = tauri::Builder::default();

    // 剪贴板插件：桌面与移动端都要（移动端「打开即预填剪贴板文本」）
    builder = builder.plugin(tauri_plugin_clipboard_manager::init());

    // ---- 桌面专属：提前 manage + 桌面插件 -------------------------------------
    // **state 在任何插件/窗口创建之前就 manage**：WebView2 初始化会重入消息泵，
    // 单实例回调等可能在该阶段被派发——state 晚于它们就绪就会 panic（v0.2.6 实测，
    // backtrace：DispatchMessageW → CreateSharedWebViewEnvironmentInternal → state()）。
    // 配置目录手动计算（与 tauri 的 app_config_dir 一致，不依赖 app handle）。
    #[cfg(desktop)]
    {
        let config_dir = manual_app_config_dir();
        let _ = std::fs::create_dir_all(&config_dir);
        let state = load_state(config_dir);
        builder = builder.manage(state);
        // 单实例（必须第一个注册）：二次启动时这里先跑——把已有实例唤到前台，
        // 新进程随即退出。启动菜单/自启/热键外再点一次图标，不会再开出第二个托盘。
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let state = app.state::<AppState>();
            if let Some(window) = app.get_webview_window("popup") {
                let _ = window.show();
                state.set_window_visible(true);
                let _ = window.set_focus();
                let _ = app.emit_to("popup", "mydict:shown", ShownPayload { focused: true });
                startup_log("[single-instance] 二次启动 → 已唤起现有实例");
            }
        }));
        builder = builder.plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            // 自启时静默进托盘：不带 --show，窗口保持隐藏
            Some(vec!["--tray"]),
        ));
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // 只在按下时动作：否则按下+抬起会切换两次
                    if event.state() == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .build(),
        );
    }

    builder = builder
        .setup(|app| {
            // ---- Android：单窗口 + 配置文件目录来自 app handle -------------------
            #[cfg(mobile)]
            {
                // 移动端在拿到 app handle 后才知道可写的私有目录；state 在此 manage
                // （命令在 setup 之后才会被调用）。桌面端仍走上面的提前 manage。
                let dir = app
                    .path()
                    .app_config_dir()
                    .unwrap_or_else(|_| PathBuf::from("."));
                let _ = std::fs::create_dir_all(&dir);
                app.manage(load_state(dir));
                // 单窗口：确保主窗口可见（移动端没有「启动隐藏」的形态）
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }

            // ---- 桌面：热键 / 托盘 / 剪贴板 / 圆角 / 调试开关 --------------------
            #[cfg(desktop)]
            {
                let spec = app.state::<AppState>().settings().hotkey.clone();
                startup_log("setup: 配置加载完成");
                register_hotkey(app.handle(), &spec);
                startup_log("setup: 热键注册流程完成");
                // 托盘建不起来不该拖垮应用：热键与查词是主功能，托盘只是常驻入口
                if let Err(err) = build_tray(app.handle()) {
                    eprintln!("[tray] 托盘构建失败（不影响热键与查词）：{err}");
                }
                startup_log("setup: 托盘/剪贴板初始化完成");
                start_clipboard_watch(app.handle().clone());
                // Windows 11：系统级圆角（阴影沿圆角绘制，圆角外不再有像素残留）
                #[cfg(target_os = "windows")]
                {
                    for label in ["main", "popup", "viewer"] {
                        if let Some(w) = app.get_webview_window(label) {
                            if let Ok(hwnd) = w.hwnd() {
                                set_dwm_rounded_corners(hwnd.0 as isize);
                            }
                        }
                    }
                }
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
                            let r2 = window.set_position(tauri::PhysicalPosition::new(
                                geometry.x,
                                geometry.y,
                            ));
                            eprintln!("[show] set_size={r1:?} set_position={r2:?}");
                        }
                        let _ = window.set_focus();
                        app.state::<AppState>().set_window_visible(true);
                        let _ =
                            app.emit_to("popup", "mydict:shown", ShownPayload { focused: true });
                    }
                }
                startup_log("setup: 完成（窗口已创建）");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 快捷搜索窗的移动/缩放：记住上一次的尺寸与位置。拖动会连续触发事件，
            // 这里只记最新值并交给防抖线程，静止 600ms 后落盘一次。（桌面专属）
            #[cfg(desktop)]
            {
                if window.label() != "popup" {
                    return;
                }
                if !matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                    return;
                }
                let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size())
                else {
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
            }
            #[cfg(not(desktop))]
            {
                let _ = (window, event);
            }
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
            show_viewer,
            close_viewer,
            translate,
            online_lookup,
            clipboard_text,
            take_shared_text,
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("应用启动失败");
}

// ======================= 桌面专属：托盘 / 热键 / 剪贴板 =======================

/// 常驻托盘：显示/隐藏、设置、开机自启（勾选）、退出；左键点图标 = 切换窗口。
///
/// Linux 上托盘走 StatusNotifier（XFCE 面板的 indicator 插件提供宿主），没有宿主时图标不显示，
/// 但不影响主功能——热键与 Esc 照旧可用。
#[cfg(desktop)]
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
            startup_log(&format!("[menu] 触发：{id}"));
            // 菜单 activate 回调跑在主线程（GTK）：在这里直接做窗口操作会与菜单的
            // deactivation 重入，实测会把 libappindicator 的菜单服务搞死——之后宿主
            // 再也弹不出菜单。全部动作派发到独立线程，回调立即返回。
            let app = app.clone();
            std::thread::spawn(move || match id.as_str() {
                "toggle" => toggle_window(&app),
                "main" => show_main(&app),
                "settings" => {
                    if let Some(window) = app.get_webview_window("popup") {
                        startup_log("[tray] settings → show popup");
                        let _ = window.show();
                        app.state::<AppState>().set_window_visible(true);
                        let _ =
                            app.emit_to("popup", "mydict:shown", ShownPayload { focused: true });
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
#[cfg(desktop)]
struct TrayState {
    autostart_item: CheckMenuItem<tauri::Wry>,
}

/// 注册（或重新注册）全局热键；失败原因记进状态，设置页要能看到——静默失败会让用户
/// 以为「热键没反应」，而那其实是「被别的软件占了」。
#[cfg(desktop)]
fn register_hotkey(app: &tauri::AppHandle, spec: &str) {
    let state = app.state::<AppState>();
    let _ = app.global_shortcut().unregister_all();
    match parse_hotkey(spec) {
        Ok(shortcut) => match app.global_shortcut().register(shortcut) {
            Ok(()) => {
                eprintln!("[hotkey] 注册成功：{spec}");
                state.set_hotkey_error(None);
            }
            Err(err) => state.set_hotkey_error(Some(format!(
                "热键 {spec} 注册失败（可能被别的程序占用）：{err}"
            ))),
        },
        Err(err) => state.set_hotkey_error(Some(err)),
    }
}

/// `ctrl+alt+f` / `Super+Shift+Space` 这类写法 → 插件的 Shortcut
#[cfg(desktop)]
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

#[cfg(desktop)]
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
#[cfg(desktop)]
fn toggle_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("popup") else {
        return;
    };
    let state = app.state::<AppState>();
    let visible = state.is_window_visible();
    if visible {
        startup_log("[hotkey] 可见 → 收起");
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
    startup_log(&format!(
        "[hotkey] 呼出（{}）",
        if selected.is_empty() { "普通模式" } else { "划词模式" }
    ));

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
#[cfg(all(desktop, unix))]
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

#[cfg(not(all(desktop, unix)))]
fn active_window_id() -> Option<String> {
    None
}

/// 打开词典主界面（重型浏览窗口）；若快捷搜索窗开着，让它让位
#[cfg(desktop)]
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
#[cfg(desktop)]
fn start_clipboard_watch(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(700));
            let (enabled, visible) = {
                let state = app.state::<AppState>();
                (state.settings().clipboard_watch, state.is_window_visible())
            };
            // 用户口径（v0.3.1）：剪贴板监听**只在面板已显示时生效**——
            // 面板收起时复制不做任何事，绝不主动呼出面板
            if !enabled || !visible {
                continue;
            }
            #[cfg(all(unix, not(target_os = "macos")))]
            let text = read_xclip("clipboard");
            #[cfg(target_os = "windows")]
            let text = read_clipboard_text();
            // 只认 ≤60 字的文本：更长的多半是整段内容，不是查词意图
            let trimmed = text.trim().to_string();
            if trimmed.is_empty() || trimmed.chars().count() > 60 || trimmed == last {
                continue;
            }
            last = trimmed.clone();
            startup_log(&format!(
                "[clipboard] visible={visible} 命中新文本：{}",
                &trimmed.chars().take(12).collect::<String>()
            ));
            let _ = app.emit_to("popup", "mydict:word", trimmed);
        }
    });
}

/// 给前端的「窗口已显示」事件载荷
#[cfg(desktop)]
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
#[cfg(all(desktop, unix))]
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
#[cfg(all(desktop, unix))]
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

#[cfg(not(all(desktop, unix)))]
fn read_xclip(_selection: &str) -> String {
    String::new()
}

/// Windows：读 CLIPBOARD 文本（arboard；剪贴板被占用等瞬时失败按空串处理，
/// 下一个 700ms 轮询周期自然重试）
#[cfg(target_os = "windows")]
fn read_clipboard_text() -> String {
    arboard::Clipboard::new()
        .and_then(|mut cb| cb.get_text().map(|t| t.trim().to_string()))
        .unwrap_or_default()
}

#[cfg(not(all(desktop, unix)))]
fn read_selection() -> String {
    // Windows 桌面：TODO(M3) 走 UIA；Android：无系统划词读取，返回空串
    String::new()
}

/// 悬浮窗落在鼠标所在那块屏的中上部；拿不到鼠标位置就退回居中
#[cfg(desktop)]
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

// ============================== 命令层 ==============================

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let state = app.state::<AppState>();
    // 桌面：热键要先校验再落盘，否则写坏了下次启动热键就没了
    #[cfg(desktop)]
    let previous_hotkey = state.settings().hotkey;
    #[cfg(desktop)]
    parse_hotkey(&settings.hotkey)?;
    state.set_settings(settings.clone());
    // 广播给全部窗口：另一侧窗口里的 settings 副本（主题/服务器地址…）不用重启才生效
    let _ = app.emit("mydict:settings-updated", settings.clone());
    #[cfg(desktop)]
    if settings.hotkey != previous_hotkey {
        register_hotkey(&app, &settings.hotkey);
    }
    Ok(())
}

#[tauri::command]
fn hotkey_error(state: tauri::State<'_, AppState>) -> Option<String> {
    state.hotkey_error()
}

/// 注意：带引用入参（`State<'_, T>`）的 async 命令必须返回 `Result`——这是 Tauri 的宏约束。
#[tauri::command]
async fn auth_status(state: tauri::State<'_, AppState>) -> Result<AuthStatus, String> {
    // debug：默认值里带了测试账号就顺手登录，省得测试版每次手填
    #[cfg(debug_assertions)]
    dev::ensure_login(&state).await;
    Ok(state.auth_status())
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
    state.search(&word, dict_ids.as_deref()).await
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
    #[cfg(all(desktop, unix))]
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
    #[cfg(not(all(desktop, unix)))]
    {
        "0|".to_string()
    }
}

/// 前端请求打开词典主界面（popup 的 ⧉ 按钮）。
/// 不用 JS 的 WebviewWindow.getByLabel：它对 Rust 配置里创建的窗口不一定可见。
#[tauri::command]
fn open_main(app: tauri::AppHandle) {
    #[cfg(desktop)]
    show_main(&app);
    #[cfg(not(desktop))]
    {
        // 移动端只有一个窗口：显示它即可
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
            let _ = app.emit_to("main", "mydict:main-shown", ());
        }
    }
}

/// 前端的诊断写入 stderr + 配置目录 debug.log（Windows release 下 stderr 无效，
/// 文件日志是唯一的诊断通道）
#[tauri::command]
fn note(app: tauri::AppHandle, tag: String) {
    app.state::<AppState>().log(&format!("[front] {tag}"));
}

/// 词条图片查看器：**启动时就在 tauri.conf.json 里建好**（隐藏），点图只做三件事——
/// 改几何到词条所在显示器、投递载荷（emit mydict:viewer-image）、前端就绪后显示。
///
/// 为什么不在点图时创建窗口：v0.1.0~v0.1.2 在 Windows 上连环假死（点图无反应 →
/// 主界面关闭/托盘全灭 → 单实例拦住二次启动，只能注销）。运行时创建窗口这条路在
/// Windows/WebView2 上不可靠（换线程、换时机都试过仍假死），干脆彻底绕开——
/// 窗口随应用启动建好、全程隐藏，点图路径只剩窗口方法与事件投递。
///
/// 移动端 M0：没有 viewer 独立窗口，命令保留但退化为 no-op（前端灯箱覆盖层用于后续里程碑）。
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
    let state = app.state::<AppState>();
    let Some(viewer) = app.get_webview_window("viewer") else {
        state.log("[viewer] 无 viewer 窗口（移动端 M0）");
        return;
    };
    // 桌面：把 viewer 窗口挪到词条所在显示器并铺满，再投递载荷。
    // 移动端 M0 没有独立 viewer 窗口（上面已 return），这段整体门控掉。
    #[cfg(desktop)]
    {
        // Linux 保持「不进任务栏」的原有形态；Windows 必须留在任务栏（逃生入口）。
        let _ = viewer.set_skip_taskbar(!cfg!(windows));
        let monitor = window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten());
        if let Some(monitor) = monitor {
            let origin = *monitor.position();
            let bounds = *monitor.size();
            let _ = viewer.set_size(tauri::PhysicalSize::new(bounds.width, bounds.height));
            let _ = viewer.set_position(tauri::PhysicalPosition::new(origin.x, origin.y));
            state.log(&format!(
                "[viewer] 几何 {}x{}@{},{}",
                bounds.width, bounds.height, origin.x, origin.y
            ));
        }
        state.stage_viewer_payload(payload.clone());
        let _ = app.emit_to("viewer", "mydict:viewer-image", payload);
        state.log("[viewer] 载荷已投递，等前端就绪后 show_viewer");
    }
    #[cfg(not(desktop))]
    {
        let _ = (&viewer, &window, payload);
        state.log("[viewer] 移动端无独立查看器窗口（M0 用覆盖层替代）");
    }
}

/// 查看器页面就绪后取初始图片载荷（取走即清）。窗口随应用启动创建，页面启动时
/// 调用此命令时通常还没有载荷（正常载荷走事件投递），保留是为了协议完整。
#[tauri::command]
fn take_viewer_payload(app: tauri::AppHandle) -> Option<mydict::ViewerPayload> {
    app.state::<AppState>().take_viewer_payload()
}

/// 查看器前端就绪（已拿到图片并开始渲染）后由前端调用：此刻显示窗口并聚焦。
/// 窗口常驻隐藏，黑底界面就绪后才上屏。
#[tauri::command]
fn show_viewer(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    if let Some(viewer) = app.get_webview_window("viewer") {
        let _ = viewer.show();
        let _ = viewer.set_focus();
        state.log("[viewer] 已显示");
    }
}

/// 查看器里退出了（Esc/点空白），隐藏窗口（常驻，下次点图复用）。
#[tauri::command]
fn close_viewer(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    if let Some(viewer) = app.get_webview_window("viewer") {
        let _ = viewer.hide();
        state.log("[viewer] 已隐藏");
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
    let _ = window.hide();
    eprintln!("[hide] 前端请求收起");
    // 记账只对应 popup（热键/剪贴板的状态机针对它）；主界面的收起与此无关
    if window.label() == "popup" {
        app.state::<AppState>().set_window_visible(false);
    }
    let _ = app.emit_to("popup", "mydict:hidden", ());
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

#[cfg(all(desktop, unix))]
fn open_url(url: &str) -> std::io::Result<()> {
    std::process::Command::new("xdg-open").arg(url).spawn().map(|_| ())
}

#[cfg(target_os = "android")]
fn open_url(_url: &str) -> std::io::Result<()> {
    // 移动端 M0 暂不支持从词条内打开外部浏览器（后续用 openUrl/Intent 实现）
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "安卓端暂不支持打开外链",
    ))
}
