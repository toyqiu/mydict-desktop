// Gradle 的 rust 任务以 `node tauri android android-studio-script …` 回调 Tauri CLI，
// 工作目录是 src-tauri；而 src-tauri 下没有名为 tauri 的包 → Node 解析不到。
// 本 shim 把它转发到工程根的 @tauri-apps/cli（与 MyReader 的 tauri.js 同款做法）。
//
// 注意：Node 会向上找到工程根的 package.json（"type": "module"），所以本文件按 ESM 解析，
// 必须用 createRequire 而不是直接 require。
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('../node_modules/@tauri-apps/cli/tauri.js')
