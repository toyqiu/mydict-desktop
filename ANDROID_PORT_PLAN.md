# mydict-desktop 安卓移植评估与实施计划

> 目标：把桌面版 `mydict-desktop`（Tauri 2 查词器）的能力带到 Android。
> 本文是**评估 + 实施计划**，含已定决策、复用盘点、能力缺口、里程碑与已知坑。
> 结论基于对本仓库源码的实测（非推测），引用均给出 `文件:行`。

---

## 0. 决策记录（已定）

| 项 | 决策 |
|---|---|
| 技术路线 | **A：Tauri 2 Android 移植**（复用 Rust 核心 + 前端，不重写 Kotlin） |
| 入口形态 | **三项并存**：① `ACTION_PROCESS_TEXT` 系统划词菜单（主）② 分享面板 `ACTION_SEND` ③ 快捷设置磁贴 `TileService`（辅） |
| 「悬浮在别的 App 之上」 | **不做**（`SYSTEM_ALERT_WINDOW` 代价高、体验差；与上面三个入口冲突） |
| 分发 | **自签 APK 侧载**（同 MyReader APK 的做法） |
| 仓库结构 | **同仓双 target**（一个仓库同时构建桌面与 Android，最大化复用、单源演进） |

---

## 1. 一句话结论

桌面版**能**移植，但它不是「把桌面 App 装到手机」，而是「**共用 60–70% 代码、重做一个安卓外壳**」。
桌面版最核心的交互（全局热键 + 置顶悬浮窗 + 剪贴板自动弹）在安卓上**全部不存在**，必须换成**系统划词菜单 / 分享面板 / 磁贴**；
而桌面版最有价值的资产（MyDict 的 Rust 客户端 + 词条渲染前端）**几乎可以原样复用**。

---

## 2. 复用盘点（实测）

| 资产 | 位置 | 复用度 | 说明 |
|---|---|---|---|
| MyDict HTTP / 会话层 | `src-tauri/src/mydict.rs`（540 行） | **≈100%** | 登录、JWT 静默续期（`refresh`/`access_or_refresh`）、`search`/`entry_html`/`dictionaries`、配置落盘。只用 `std` + `reqwest(rustls)`，安卓原生可用。唯一牵连：`use crate::DEFAULT_HOTKEY`（mydict.rs:17）与 `Settings.hotkey` 字段 |
| 命令层（API 类） | `main.rs` 的 `search` / `login` / `logout` / `auth_status` / `dictionaries` / `entry_html` / `translate` / `online_lookup` / `open_external` | **≈100%** | 纯 HTTP，无平台依赖 |
| 词条渲染前端 | `src/entry-frame.ts`、`ui-popup.ts`、`ui-main.ts`、`translate.ts`、`online.ts`、`image-lightbox.ts`、`theme.css`（约 2400 行） | **≈80%** | **关键发现**：整个前端只依赖 `@tauri-apps/api/core` 的 `invoke` 与 `@tauri-apps/api/event` 的 `listen`（grep 全 `src/` 确认），**没有任何一处直接调用 window API**。安卓端只要保持同名命令/事件，渲染层可整段搬 |
| 词条 iframe 复用链路 | `<base>` 注入 + `srcdoc` + `mydict:*` 消息（`entry-frame.ts`） | **100%** | 最难复制的一环，白拿 |
| 图片查看器（幻灯片） | `image-lightbox.ts` + `ui-viewer.ts` + `.lightbox`/`.viewer-bg-toggle` 样式 | **≈90%**（去掉独立窗口） | 逻辑复用；「独立 window」改为应用内覆盖层 |
| 桌面外壳 | 热键 / 托盘 / 单实例 / 剪贴板轮询 / 窗口几何 / viewer 独立窗 | **0%** | 必须删掉重做 |

**需要改动的前端点（很少）**：
- 入口事件来源：原由 Rust 热键/剪贴板发 `mydict:shown` / `mydict:word`（`main.rs:641-644,718`）；安卓改为 intent → Rust → **发同名事件**，前端几乎不动。
- `ui-popup.ts` / `ui-main.ts` 的「失焦收起 / 点外收起」逻辑在单窗口形态下需简化。
- `settings-modal.ts` 里桌面专属项（热键、剪贴板监听、划词优先）在安卓隐藏。

---

## 3. 桌面能力 → 安卓现实（能力缺口）

| 桌面能力 | 安卓现实 | 替代方案 |
|---|---|---|
| 全局热键 `super+shift+d` | **无全局热键** | `ACTION_PROCESS_TEXT`（在任意 App 划词 → 系统选择菜单出现本 App）／分享面板／磁贴 |
| 无边框**置顶悬浮窗** | 应用无法浮动在别的 App 之上 | 仅 `SYSTEM_ALERT_WINDOW`（已决定不做）→ 入口唤起后**全屏查词页** |
| 托盘常驻 | **无托盘** | 通知渠道 / 磁贴 / 长按图标快捷方式 |
| 剪贴板监听自动弹 | Android 10+ **后台读剪贴板被禁** | 不做；用划词菜单 / 分享替代 |
| 划词（X11 PRIMARY / Win UIA） | 系统提供划词 | `ACTION_PROCESS_TEXT` |
| 三窗口 main/popup/viewer | 手机单 Activity；多窗口需 Activity Embedding（**12L+/API32+，平板 ≥840dp**），手机上=压栈 | **单 Activity + 路由**；viewer 做覆盖层 |
| 单实例 / 开机自启 / 失焦收起 / 窗口几何记忆 | 无对应概念 | 直接删除 |

> **产品结论**：安卓的「快捷查词入口」= **系统划词菜单 + 分享面板**，不是热键 + 悬浮窗。这决定了 M2 的形态。

---

## 4. 为什么是路线 A（三条路线对比）

| 路线 | 收益 | 成本 | 新增风险 | 风险窗口 |
|---|---|---|---|---|
| **A. Tauri 2 Android**（本文选定） | 高：复用两大利器；**与桌面版同源演进**（改查词链路只写一遍） | 中：安卓外壳 + 入口 intent 胶水 + 产物 ~50–60MB | 中：WebView 行为差异、intent 原生胶水、明文 HTTP/CSP（**已知坑**）、签名分发 | 中（本机已有 MyReader 成功构建先例） |
| B. Kotlin 原生壳 + WebView + OkHttp | 中：MVP 出得快，纯 Kotlin 简单 | 中：重写 HTTP/会话层（~300 行 Kotlin）+ JS bridge；前端要改掉 `invoke/listen` | **高：双份维护**——以后每次改查词/翻译/在线词典都要写两遍，迟早分叉 | 长（维护期一直存在） |
| C. 不移植，直接用 MyDict 网页版 PWA | 低-中：零开发，立刻能用 | ≈0 | 低：无桌面版体验（无划词入口、无灯箱背景切换） | 无 |

**A 对 B 严格更优，只有一条例外**：若只想两周内出「能查词」的最小工具、且不再同步桌面版功能，则 B 更快。只要还要继续打磨桌面版，B 的「双份维护」必然反噬。

---

## 5. 目标架构（安卓端）

```
单 Activity
 └─ 主 WebView（复用现有 dist/ 前端）
     ├─ 搜索页        （原 popup/main 的搜索框 + 命中列表）
     ├─ 结果页        （语言标签 / 在线词典 / 翻译 / 命中分组）
     └─ 查看器覆盖层  （原 ui-viewer 的灯箱，去掉独立 window）

入口（三种，全部汇入同一条链路）：
  ACTION_PROCESS_TEXT ─┐
  分享面板 ACTION_SEND ─┼─→ Kotlin 取文本 ─→ Rust（Tauri bridge）─→ emit mydict:word
  磁贴 TileService ─────┘                                            ↓
                                                            前端既有逻辑（几乎不改）
```

**要点**：
- 移动端入口要在 Rust 侧加 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`，**不依赖 `tauri.conf.json` 的三窗口配置**（那是桌面形态）。
- `Settings` 里桌面字段（`hotkey`/`selection_first`/`clipboard_watch`/`popup_geometry`）在安卓**保留但隐藏/忽略**，这样配置结构两端一致、`mydict.rs` 零改动。
- 保留 `translate` / `online_lookup` 两条与管理端无关的能力（翻译走 Edge 免 key；在线词典走 MyDict `/api/dict/online/lookup`）。
- `mydict.rs:17` 的 `use crate::DEFAULT_HOTKEY` 需在移动端给一个占位默认值（或 `cfg` 掉）。

---

## 6. 里程碑

### M0 · 可行性验证（先做，风险最高）
1. `tauri android init --ci` 生成 Android 工程（**必须 `--ci`**，否则交互提示静默挂住）。
2. 搬 `mydict.rs` + API 命令层；移动端入口改造 `main()`。
3. 前端先只留一个输入框 → 查询 → 命中列表。
4. **验证三件事**：reqwest(rustls) 在 Android 通不通、**明文 HTTP**、**CSP**。
   - 通过标准：真机/模拟器输入「test」出命中；词条 iframe 能取到 HTML 并渲染。
5. 产出：可安装的 debug APK。

### M1 · 核心查词
- 搬 `entry-frame.ts`（iframe 词条渲染）+ 命中列表 + 语言标签 + 在线词典 + 翻译 + 灯箱（含背景切换）。
- 登录 / 设置本地持久化（`server_url`/账号/json 落盘，路径改用安卓 `app_config_dir`）。
- 通过标准：与桌面版同样的词条渲染效果、发音、大图查看。

### M2 · 三种入口（本次决策的核心）
- **`ACTION_PROCESS_TEXT`（主）**：在任意 App 划词 → 菜单出现「MyDict 查词」→ 唤起结果页。
  ```xml
  <!-- gen/android/.../AndroidManifest.xml，挂在 MainActivity 上 -->
  <intent-filter>
    <action android:name="android.intent.action.PROCESS_TEXT" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="text/plain" />
  </intent-filter>
  ```
  Kotlin 侧读 `Intent.EXTRA_PROCESS_TEXT`（只读态用 `EXTRA_PROCESS_TEXT_READONLY`）。
- **分享面板（辅）**：`ACTION_SEND` + `text/plain`，读 `Intent.EXTRA_TEXT`。
- **磁贴（辅）**：`TileService`，`<action android:name="android.service.quicksettings.action.QS_TILE"/>`；点击打开应用内搜索页。
- **胶水**：改 `gen/android` 的 `MainActivity.kt`（`onCreate`/`onNewIntent`）取文本，经 Tauri 的 Rust bridge 传给 Rust，Rust 再 `emit mydict:word` 复用既有前端链路。**这是 M2 的主要工程量与风险点。**

### M3 · 打磨与分发
- viewer 覆盖层/第二 Activity 二选一（手机建议覆盖层）。
- 深色主题、字体缩放、返回键语义（返回 = 收起覆盖层 / 退出结果页）。
- 自签 APK 侧载分发（keystore 移出工作树、绝不入库）。

---

## 7. 本机已有先例与已知坑（可直接抄）

这台 NAS **成功构建并真机验证过 Tauri 安卓 APK**（MyReader，产物 `/vol1/1000/docker/myreader-apk/`）。工具链齐全：
`/opt/android-sdk`（build-tools 35、platform 35/36）、NDK `26.2.11394342`、JDK 17、Rust `aarch64-linux-android`、pnpm。

本次大概率再遇到的坑与对应修法（**都已在 MyReader 上验证过**）：

1. **release 构建禁止明文 HTTP**：`tauri android init` 在 `defaultConfig` 写 `manifestPlaceholders["usesCleartextTraffic"]="false"`（仅 debug 覆盖为 true）→ 自建 MyDict 多为 LAN `http://`，会被系统拦掉（图片/发音/CSS 全挂）。
   → 改 `build-signed-apk.ts` + CI 里 `sed` 成 `"true"`；验证 `aapt2 dump xmltree --file AndroidManifest.xml <apk> | grep -i cleartext`。
2. **CSP 缺 `media-src`**：直链 mp3 被拦（日语走 spx→blob 所以能响，英语全哑）；`style-src`/`font-src` 也要放行 `http://*`。
   → `tauri.conf.json` 的 CSP 补 `media-src`、`http://*`。
3. **gradle 回调需要 `node tauri` 的 shim**：`app/src-tauri/tauri.js`（ESM + `createRequire`）。
4. **Maven/crates/gradle 都要代理或镜像**：`~/.cargo/config.toml` 代理；`~/.gradle/init.gradle.kts` 注入阿里云镜像并把 `maven.aliyun.com` 加入 `nonProxyHosts`；sdkmanager 不稳就直连 `dl.google.com` 下官方 zip 解压进 `/opt/android-sdk`。
5. **签名**：keystore 移出工作树（04500/0600），构建时显式传 `ANDROID_KEY_PASSWORD`；**自签 APK 与其它已装版签名不同 → 必须先卸载才能安装**（会清本地数据）。
6. **验证套路（不装真机也能查）**：`apksigner verify --print-certs`、`aapt2 dump badging`、`unzip -l | grep lib/`、grep `lib/arm64-v8a/lib*.so` 里的前端资源键。

**排查「平台独有的资源/媒体失败」顺序**：①资源本身能否取到（curl 两种入口）②响应头 content-type ③CSP（`media-src`/`img-src`/`style-src`/`connect-src`，按类型回退到 `default-src`）④明文流量（manifest）⑤混合内容（源协议，安卓 WebView 源是 `http://tauri.localhost`，通常无此问题）。

---

## 8. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| ACTION_PROCESS_TEXT 的 Kotlin ↔ Rust 胶水（M2） | **高** | M0 就先做一条最小 intent → Rust 通路验证；不晚于 M2 前锁定 bridge 方式 |
| 明文 HTTP / CSP 在 release 被拦 | 中（**已知**） | 按 §7.1/§7.2 直接打补丁，M0 就验证 |
| Tauri 安卓 WebView 行为差异（iframe srcdoc、`file://` 资源） | 中 | M0 用真实词条图验证 `entry_html` + iframe 链路 |
| 与桌面共用仓库导致构建配置互相干扰 | 低-中 | 同仓但 Android 工程放 `src-tauri/gen/android`（已忽略），配置用 `tauri.conf.json` 的 desktop/mobile 差异或独立 `--config` |
| 自签分发被用户侧安全策略拦 | 低 | 与 MyReader APK 一致（用户已能侧载） |

---

## 9. 待确认 / 暂不做

- **待确认**：磁贴点击是「打开应用内搜索页」还是「直接唤起最近一次查询」？（默认：打开搜索页）
- **待确认**：返回键在结果页的语义 —— 返回上一级还是直接退出？（默认：覆盖层优先收起，结果页返回退出）
- **暂不做**：`SYSTEM_ALERT_WINDOW` 悬浮球；通知常驻；开机自启；剪贴板后台监听。
- **不改**：`mydict.rs` 的接口契约（两端共用），因此服务端零改动。

---

## 10. 下一步

从 **M0（可行性验证）** 起步：`tauri android init --ci` → 移动端入口改造 → 搬 `mydict.rs` + API 命令 → 最小查询页 → 真机验证明文 HTTP/CSP/reqwest 三件事。
M0 通过即证明整条路线成立，再进入 M1 的渲染层搬迁。

---

## 11. M0 实施记录（已完成，待真机验收）

**产物**：`/vol1/1000/docker/mydict-desktop-android/mydict-desktop-android-debug-aarch64.apk`（arm64-v8a，debug，184MB——debug 未剥离符号，release 会小很多）。

**代码改动**（同仓双 target）：
- `src-tauri/src/lib.rs`（新增，应用主体）+ `main.rs` 变薄壳；桌面专属能力全部 `#[cfg(desktop)]` 门控。
- `src-tauri/Cargo.toml`：新增 `[lib]`（`staticlib/cdylib/rlib`）；三个桌面插件按目标门控。
- `src-tauri/tauri.android.conf.json`（新增）：Android 单窗口 → `index.html`（复用现有 `ui-main` 查询界面）。
- `src-tauri/capabilities/default.json`（加 `platforms` 门控）+ `capabilities/mobile.json`（新增）。
- `src-tauri/tauri.js`（新增）：gradle 回调 CLI 的 shim（**必须 ESM**，见脚本注释）。
- `scripts/build-android.sh`（新增）：init + 打补丁 + 构建 + 拷产物，一键复现。

**构建**：`scripts/build-android.sh`（内部：`tauri android build --debug --target aarch64 --apk`）。

**静态验证（已通过）**：
- 包名 `com.toyqiu.mydict.desktop`，versionName `0.3.4`，`targetSdk 36` ✓
- `android.permission.INTERNET` ✓
- `usesCleartextTraffic=true`（release 也放行）✓
- `lib/arm64-v8a/libmydict_desktop_lib.so` 存在、前端资源已编入 ✓
- `apksigner verify`：Android Debug 证书（自签）✓
- 桌面 `cargo check` 与 android `cargo check` 均通过（无回归）✓

**M0 收尾（需在手机上做，本机无模拟器/设备）**：
1. 手机侧载该 APK（debug 自签，需允许「未知来源」）。
2. 设置页填 MyDict 服务器与账号 → 登录。
3. 查一个词 → 断言命中列表出、点开词条 iframe 能渲染（验证 reqwest + 明文 HTTP + iframe 链路）。

> 这一步通过即宣告 M0 完成、整条路线成立，可进入 M1。CSP 当前 `null`，不构成阻碍。

### M0 验收结果（2026-10-06，真机通过）

手机侧载后实测：**登录、语言标签行（中文 31 / 英文 17 / 日文 21，共 69 部词典）、命中列表、词条 iframe 渲染全部正常** —— reqwest + 明文 HTTP + iframe 链路均验证通过，**M0 完成**。

**UI 形态修正**：桌面版「词典主界面」（`ui-main`，双栏：左命中列表 + 右词条）在手机上把词条挤成细条，不可用。已改为加载**「快捷搜索面板」`popup.html`（`ui-popup`，单栏手风琴）**——见 `tauri.android.conf.json`。移动端同时隐藏面板标题栏里的「⧉ 打开主界面」「✕ 收起窗口」（单窗口下无意义，见 `ui-popup.ts` 的 `IS_MOBILE`）。

**测试默认值**：`src-tauri/dev.defaults.json`（gitignore，debug-only）内置服务器地址与测试账号，构建时经 `build.rs` 嵌入，启动自动登录/补空字段；release 构建不编译该模块，发布时无需改代码即可剥离。


