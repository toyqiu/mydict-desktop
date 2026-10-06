use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // 本地测试默认值（服务器地址 + 测试账号）从 **gitignore** 的 `dev.defaults.json` 读入，
    // 生成到 OUT_DIR 供 lib.rs include!（编译期嵌入，设备上没有该文件也能用）。
    // 文件缺失就生成空的 —— 新鲜 clone 也能编译，且凭据永不进 git。
    // 只有 debug 构建会使用它（见 lib.rs 的 `dev` 模块），发布版天然不含这些值。
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let json_path = manifest.join("dev.defaults.json");
    let json = std::fs::read_to_string(&json_path).unwrap_or_default();
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("dev_defaults.rs");
    std::fs::write(
        &out,
        format!("pub const DEV_DEFAULTS_JSON: &str = r#\"{json}\"#;\n"),
    )
    .expect("写入 dev_defaults.rs 失败");
    // 文件出现/变化时重新生成
    println!("cargo:rerun-if-changed=dev.defaults.json");
}
