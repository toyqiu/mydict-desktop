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

# 注意：release 是 tauri android build 的**默认**（只有 --debug 开关），别传 --release（不认）
PROFILE="debug"
ARGS=(--debug)
if [[ "${1:-}" == "--release" ]]; then
  PROFILE="release"
  ARGS=()
fi

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
#      分享/划词一律由**独立的 ShareReceiverActivity** 接收，把文本落到
#      <dataDir>/shared_text.txt 后，用普通启动意图打开 MainActivity 并结束自己。
#      **不要让 ACTION_SEND / ACTION_PROCESS_TEXT 直接落到 Tauri 的 MainActivity 上**——
#      实测这样会白屏（外部 intent 带着非 Tauri 的参数启动 Tauri activity，初始化异常）。
PACKAGE="$(grep -m1 'namespace = "' "$GRADLE" | sed 's/.*namespace = "\(.*\)".*/\1/')"
JAVA_DIR="$ROOT/src-tauri/gen/android/app/src/main/java/${PACKAGE//./\/}"
mkdir -p "$JAVA_DIR"

KOTLIN_MAIN="$(cat <<'KOTLIN'
package __PKG__

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
KOTLIN
)"

KOTLIN_SHARE="$(cat <<'KOTLIN'
package __PKG__

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import java.io.File

/**
 * 分享 / 划词的接收器：**独立于 Tauri 的 MainActivity**。
 *
 * 只做一件事——把外部送来的文本写进 <dataDir>/shared_text.txt，然后用**普通启动意图**
 * 打开 MainActivity，再结束自己（半透明主题 + noHistory，用户看不到这个中间页）。
 * 前端启动 / 回到前台 / 轮询时用 take_shared_text 命令取走（取走即删）。
 *
 * 为什么要独立成 Activity：ACTION_SEND / ACTION_PROCESS_TEXT 是系统或别的 App 带外部
 * 参数发起的，直接落到 Tauri 的 activity 上会白屏（Tauri 侧初始化被外部 intent 干扰）。
 *
 * 两条入口的取文本位置：
 *   - ACTION_SEND：多数 App 放 EXTRA_TEXT（可能是 Spanned），也有的只放 ClipData
 *   - ACTION_PROCESS_TEXT：划词菜单，放 EXTRA_PROCESS_TEXT
 * 路径与 Rust 的 app_data_dir() 一致——Android 上它就是 Context.dataDir，不拼 identifier。
 */
class ShareReceiverActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    capture(intent)
    val launch = Intent(this, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    startActivity(launch)
    finish()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    capture(intent)
  }

  private fun capture(intent: Intent?) {
    if (intent == null) return
    val raw = when (intent.action) {
      Intent.ACTION_SEND ->
        intent.getCharSequenceExtra(Intent.EXTRA_TEXT)
          ?: intent.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)
      Intent.ACTION_PROCESS_TEXT -> intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)
      else -> null
    }
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

printf '%s\n' "${KOTLIN_MAIN/__PKG__/$PACKAGE}" > "$JAVA_DIR/MainActivity.kt"
printf '%s\n' "${KOTLIN_SHARE/__PKG__/$PACKAGE}" > "$JAVA_DIR/ShareReceiverActivity.kt"
echo "[build-android] 已写入 MainActivity.kt + ShareReceiverActivity.kt（package=$PACKAGE）"

MANIFEST="$ROOT/src-tauri/gen/android/app/src/main/AndroidManifest.xml"
python3 - "$MANIFEST" <<'PY'
import re
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

# 1) 早先版本把 SEND/PROCESS_TEXT 的 intent-filter 直接挂在 MainActivity 上——实测会白屏，
#    这里把它们摘掉（改为由独立的 ShareReceiverActivity 接收）。
s = re.sub(
    r'\n\s*<intent-filter>\s*<action android:name="android.intent.action.(?:SEND|PROCESS_TEXT)"\s*/>.*?</intent-filter>',
    '',
    s,
    flags=re.S,
)

# 2) 幂等插入 ShareReceiverActivity（分享 + 划词两个入口都挂在它身上）
if 'ShareReceiverActivity' not in s:
    receiver = (
        '        <activity\n'
        '            android:name=".ShareReceiverActivity"\n'
        '            android:exported="true"\n'
        '            android:theme="@android:style/Theme.Translucent.NoTitleBar"\n'
        '            android:noHistory="true"\n'
        '            android:excludeFromRecents="true">\n'
        '            <intent-filter>\n'
        '                <action android:name="android.intent.action.SEND" />\n'
        '                <category android:name="android.intent.category.DEFAULT" />\n'
        '                <data android:mimeType="text/plain" />\n'
        '            </intent-filter>\n'
        '            <intent-filter>\n'
        '                <action android:name="android.intent.action.PROCESS_TEXT" />\n'
        '                <category android:name="android.intent.category.DEFAULT" />\n'
        '                <data android:mimeType="text/plain" />\n'
        '            </intent-filter>\n'
        '        </activity>\n\n'
    )
    idx = s.rfind('</application>')
    if idx == -1:
        raise SystemExit('[build-android] manifest 缺少 </application>')
    s = s[:idx] + receiver + s[idx:]

open(p, 'w', encoding='utf-8').write(s)
print('[build-android] manifest：分享/划词入口已挂到 ShareReceiverActivity')
PY

# 3.6) 应用名与启动图标（同样是 gen/ 生成物，每次构建重打）
RES_DIR="$ROOT/src-tauri/gen/android/app/src/main/res"
python3 - "$RES_DIR/values/strings.xml" <<'PY'
import re
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s = re.sub(r'(<string name="(?:app_name|main_activity_title)">).*?(</string>)', r'\1"MyDict"\2', s)
open(p, 'w', encoding='utf-8').write(s)
print('[build-android] 应用名已改为 MyDict')
PY
python3 - "$ROOT/src-tauri/icons/icon.png" "$RES_DIR" <<'PY'
import os
import sys
from PIL import Image

src, res = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
# Android 各密度启动图标的标准尺寸
sizes = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for dens, px in sizes.items():
    d = os.path.join(res, f'mipmap-{dens}')
    if not os.path.isdir(d):
        continue
    for name in ('ic_launcher.png', 'ic_launcher_round.png'):
        im.resize((px, px), Image.LANCZOS).save(os.path.join(d, name))
print('[build-android] 已用桌面图标替换 Android 启动图标')
PY

# 4) 清理 app/build 后构建。
#    实测：增量构建在 .so 变化后会在 APK 里残留**旧 .so 的孤立数据**（APK 体积翻倍，
#    192MB→377MB，central directory 里看不到、但确实占了空间）。清掉 app/build 即恢复；
#    cargo target / gradle 依赖都缓存着，这一清只需几秒。
rm -rf "$ROOT/src-tauri/gen/android/app/build"
cd "$ROOT"
node_modules/.bin/tauri android build ${ARGS[@]+"${ARGS[@]}"} --target "$TARGET" --apk

# 5) 拷产物到固定目录（release 未签名时 AGP 会带 -unsigned 后缀，这里通配取）
PROFILE_DIR="$ROOT/src-tauri/gen/android/app/build/outputs/apk/universal/$PROFILE"
APK="$(ls -1 "$PROFILE_DIR"/app-universal-*.apk 2>/dev/null | head -1)"
if [[ -z "$APK" ]]; then
  echo "[build-android] 未找到产物 APK：$PROFILE_DIR" >&2
  exit 1
fi
mkdir -p "$OUT_DIR"
cp -f "$APK" "$OUT_DIR/mydict-desktop-android-$PROFILE-$TARGET.apk"
echo "[build-android] 产物：$OUT_DIR/mydict-desktop-android-$PROFILE-$TARGET.apk"
