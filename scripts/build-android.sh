#!/usr/bin/env bash
# 构建 mydict-desktop 的 Android APK（Tauri v2）。
#
# 为什么要有这个脚本：`src-tauri/gen/` 是 .gitignore 的生成物，Tauri 生成的 Android
# 工程默认 compileSdk=37、release 禁明文 HTTP，本机 SDK 只装到 36 —— 每次重新 init
# 都要重打这两个补丁。本脚本负责：init（缺失时）→ 打补丁 → 构建 → 拷产物。
#
# 用法：
#   scripts/build-android.sh              # debug APK（默认，aarch64）
#   scripts/build-android.sh --release    # release APK（未签名）
#   TARGET=x86_64 scripts/build-android.sh
#
# 依赖（见 ANDROID_PORT_PLAN.md §7）：/opt/android-sdk + NDK 26.2、JDK17、rust aarch64 目标。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${TARGET:-aarch64}"
OUT_DIR="${OUT_DIR:-/vol1/1000/docker/mydict-desktop-android}"

export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/26.2.11394342}"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export PATH="$HOME/.cargo/bin:$ANDROID_HOME/platform-tools:$JAVA_HOME/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/root/mydict-android-target}"

MODE_ARGS=(--debug)
if [[ "${1:-}" == "--release" ]]; then MODE_ARGS=(--release); fi

# 1) 清理会让 gradle 走死代理的配置（本机 ~/.gradle 里的代理常已失效；direct 可通）。
#    临时移除、退出时还原，不永久改动全局配置。
GP="$HOME/.gradle/gradle.properties"
if [[ -f "$GP" ]] && grep -q proxyHost "$GP"; then
  GP_BAK="$(mktemp)"
  cp "$GP" "$GP_BAK"
  trap 'cp "$GP_BAK" "$GP"; rm -f "$GP_BAK"' EXIT
  grep -v -e proxyHost -e proxyPort -e nonProxyHosts "$GP" > "$GP.tmp" && mv "$GP.tmp" "$GP"
  echo "[build-android] 已临时移除 gradle 代理（退出时还原）"
fi

# 2) 生成 Android 工程（缺失时）
if [[ ! -d "$ROOT/src-tauri/gen/android" ]]; then
  echo "[build-android] tauri android init --ci"
  (cd "$ROOT" && node_modules/.bin/tauri android init --ci)
fi

# 3) 打补丁：compileSdk/targetSdk 37→36（本机无 android-37）；release 明文 HTTP 放行
GRADLE="$ROOT/src-tauri/gen/android/app/build.gradle.kts"
sed -i 's/compileSdk = 37/compileSdk = 36/; s/targetSdk = 37/targetSdk = 36/' "$GRADLE"
sed -i 's/manifestPlaceholders\["usesCleartextTraffic"\] = "false"/manifestPlaceholders["usesCleartextTraffic"] = "true"/' "$GRADLE"
echo "[build-android] 已打补丁：$(grep -E 'compileSdk = |targetSdk = ' "$GRADLE" | tr '\n' ' ')"

# 3.5) Android 原生补丁（gen/ 是生成物，每次构建重打）：
#      (a) MainActivity 接收系统分享（ACTION_SEND / text/plain），把文本落到
#          <dataDir>/<packageName>/shared_text.txt 交给 Rust（app_data_dir 同一路径）；
#      (b) manifest 声明接收 text/plain 分享，让 MyDict 出现在系统分享列表里。
PACKAGE="$(grep -m1 'namespace = "' "$GRADLE" | sed 's/.*namespace = "\(.*\)".*/\1/')"
JAVA_DIR="$ROOT/src-tauri/gen/android/app/src/main/java/${PACKAGE//./\/}"
mkdir -p "$JAVA_DIR"
KOTLIN_SRC="$(cat <<'KOTLIN'
package __PKG__

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    captureSharedText(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    captureSharedText(intent)
  }

  /**
   * 系统分享（ACTION_SEND / text/plain）进来的文本 → 写进 <dataDir>/shared_text.txt，
   * 前端启动/回到前台时用 take_shared_text 命令取走（取走即删）。
   * 路径与 Rust 的 app_data_dir() 一致——**注意 Android 上 app_data_dir 的默认值就是
   * getDataDir，不再拼 identifier**（tauri path/android.rs），故直接写 dataDir 根。
   */
  private fun captureSharedText(intent: Intent?) {
    if (intent == null || intent.action != Intent.ACTION_SEND) return
    // 各 App 传文本的位置不一样：多数放 EXTRA_TEXT（可能是 Spanned），
    // 也有的只放 ClipData —— 两条都取。getCharSequenceExtra 避免 Spanned 触发 ClassCastException。
    val raw = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)
      ?: intent.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)
    val text = raw?.toString()?.trim().orEmpty()
    if (text.isEmpty()) return
    try {
      // filesDir.parentFile == Context.dataDir
      val base = filesDir.parentFile ?: return
      File(base, "shared_text.txt").writeText(text)
    } catch (_: Exception) {
    }
  }
}
KOTLIN
)"
printf '%s\n' "${KOTLIN_SRC/__PKG__/$PACKAGE}" > "$JAVA_DIR/MainActivity.kt"
echo "[build-android] 已写入 MainActivity.kt（系统分享接收，package=$PACKAGE）"

MANIFEST="$ROOT/src-tauri/gen/android/app/src/main/AndroidManifest.xml"
python3 - "$MANIFEST" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
if 'android.intent.action.SEND' in s:
    print('[build-android] manifest 已有 SEND intent-filter，跳过')
    sys.exit(0)
block = (
    '            <intent-filter>\n'
    '                <action android:name="android.intent.action.SEND" />\n'
    '                <category android:name="android.intent.category.DEFAULT" />\n'
    '                <data android:mimeType="text/plain" />\n'
    '            </intent-filter>\n'
)
marker = '            </intent-filter>\n'
i = s.find(marker)
if i == -1:
    raise SystemExit('[build-android] 未找到 </intent-filter>，manifest 结构可能变了')
i += len(marker)
open(p, 'w', encoding='utf-8').write(s[:i] + block + s[i:])
print('[build-android] 已给 manifest 加上 SEND（text/plain）分享入口')
PY

# 4) 清理 app/build 后构建。
#    实测：增量构建在 .so 变化后会在 APK 里残留**旧 .so 的孤立数据**（APK 体积翻倍，
#    192MB→377MB，central directory 里看不到、但确实占了空间）。清掉 app/build 即恢复；
#    cargo target / gradle 依赖都缓存着，这一清只需几秒。
rm -rf "$ROOT/src-tauri/gen/android/app/build"
cd "$ROOT"
node_modules/.bin/tauri android build "${MODE_ARGS[@]}" --target "$TARGET" --apk

# 5) 拷产物到固定目录
APK="$ROOT/src-tauri/gen/android/app/build/outputs/apk/universal/${MODE_ARGS[0]#--}/app-universal-${MODE_ARGS[0]#--}.apk"
mkdir -p "$OUT_DIR"
cp -f "$APK" "$OUT_DIR/mydict-desktop-android-${MODE_ARGS[0]#--}-${TARGET}.apk"
echo "[build-android] 产物：$OUT_DIR/mydict-desktop-android-${MODE_ARGS[0]#--}-${TARGET}.apk"
