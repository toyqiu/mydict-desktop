// Windows 下不弹控制台窗口（release 构建）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 二进制入口：真正的应用主体在 `lib.rs` 的 `run()`——桌面与 Android 共用同一份。
//! 拆成 lib 是 Tauri v2 移动端的规范结构（Android 通过 `mobile_entry_point` 调 `run()`）。

fn main() {
    mydict_desktop_lib::run()
}
