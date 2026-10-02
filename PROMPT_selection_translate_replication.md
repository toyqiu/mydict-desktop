# PROMPT：把「划词翻译」链路移植进 mydict-desktop（自包含规格，零外部依赖）

> 本 prompt 自包含：判定规则、请求格式、可抄的实现全部内嵌，不需要访问扩展或 MyReader 源码。
> 移植自 MyDict 浏览器扩展 v0.2.0 已验证的实现（Chrome/Firefox 真机通过）。
> `【适配】`标记处对应 mydict-desktop 的现有代码位置。

---

## 0. 目标

mydict-desktop（Tauri 桌面查词器）目前只有词典链路。加入**翻译链路**，两条线路自动判定：

- 搜索框（快捷搜索窗）输入的内容像**句子/长短语** → 走翻译，展示译文
- 像**单词** → 照旧查词典
- 划词优先（`selection_first`）拿到的选区同样走自动判定
- 语言标签行右边常驻一个「**翻译**」标签：任何查询都能一键看译文；`←`/`→` 方向键在词典语言标签与翻译标签间循环

## 1. 线路自动判定（可整段抄）

```ts
/**
 * 输入应走翻译还是词典？
 *  - 不含英文字母：长度 ≥ 6 → 翻译（「政府」「ペン」等短词仍查词典）
 *  - 含英文字母：英文单词数（空白分隔）≥ 3 → 翻译（单词/两词组仍查词典）
 */
export function isTranslateCandidate(text: string): boolean {
  const raw = (text ?? '').trim()
  if (raw.length < 6) return false
  if (!/[A-Za-z]/.test(raw)) return true
  const words = raw.split(/\s+/).filter((w) => /[A-Za-z]/.test(w))
  return words.length >= 3
}

/** 粗猜源语言：假名→ja、谚文→ko、西里尔→ru、希腊→el、汉字→zh、其余→en */
export function guessSourceLang(text: string): string {
  const raw = text ?? ''
  if (/[\u3040-\u30ff]/.test(raw)) return 'ja'
  if (/[\uac00-\ud7af]/.test(raw)) return 'ko'
  if (/[\u0400-\u04ff]/.test(raw)) return 'ru'
  if (/[\u0370-\u03ff]/.test(raw)) return 'el'
  if (/[\u4e00-\u9fff]/.test(raw)) return 'zh'
  return 'en'
}

/** 目标语言与源语言同语种时纠偏（译成自己没意义） */
export function effectiveTargetLang(text: string, setting: string): string {
  const source = guessSourceLang(text)
  const target = setting || 'zh-Hans'
  if (source === 'zh' && (target === 'zh-Hans' || target === 'zh-Hant')) return 'en'
  if (source !== 'zh' && target.startsWith(source)) return 'zh-Hans'
  return target
}
```

## 2. 翻译服务：Edge 免 key 接口（无鉴权、无需任何 API key）

### 2.1 请求规格（照抄）

```
POST https://edge.microsoft.com/translate/translatetext?to=<目标语言>[&from=<源语言>]
     &isEnterpriseClient=false          ← 必带
Content-Type: application/json
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
            Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0     ← 必须伪装 Edg，否则可能 403
body: ["文本"]                            ← 裸 JSON 字符串数组，不是对象包裹
→ [ { "translations": [ { "text": "译文", "to": "zh-Hans" } ] } ]   取 [0].translations[0].text
```

`from` 省略即自动检测。该端点未见于微软官方文档、属 Edge 内置服务，可能随版本变动——所以必须走 provider 抽象（§2.3）。

### 2.2 【适配】在 Tauri 里的正确通道

**推荐：Rust 侧新增一个 command**（与现有 `search`/`entry_html` 同款走法，天然无 CORS、UA 可控）：

```rust
// src-tauri/src/ 下新增
#[tauri::command]
async fn translate(texts: Vec<String>, from: Option<String>, to: String) -> Result<Vec<String>, String> {
    let mut url = format!(
        "https://edge.microsoft.com/translate/translatetext?to={}&isEnterpriseClient=false",
        urlencoding::encode(&to)
    );
    if let Some(f) = from.as_deref() {
        if f != "auto" && !f.is_empty() {
            url.push_str(&format!("&from={}", urlencoding::encode(f)));
        }
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0")
        .json(&texts)
        .timeout(std::time::Duration::from_secs(10))
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("translate HTTP {}", resp.status()));
    }
    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(data.as_array().map(|a| a.iter()
        .map(|it| it["translations"][0]["text"].as_str().unwrap_or("").to_string())
        .collect()).unwrap_or_default())
}
```

（记得注册进 `invoke_handler`，`Cargo.toml` 确认有 `reqwest` 的 `json` feature。）

前端 `api.ts` 加一行：`translate: (texts: string[], from: string, to: string) => invoke<string[]>('translate', { texts, from: from || null, to })`。

### 2.3 Provider 抽象（哪怕只有一个 provider 也要留）

```ts
interface TranslationProvider {
  name: string
  translate(texts: string[], from: string, to: string): Promise<string[]>  // 顺序一一对应
}
const providers: Record<string, TranslationProvider> = { edge: { name: 'edge', translate: (t, f, to) => api.translate(t, f, to) } }
```

### 2.4 会话缓存（LRU，可整段抄）

```ts
const cache = new Map<string, string>()   // key = `${from||'auto'}:${to}:${text}`
const LIMIT = 200
export async function translateText(text: string, targetLang: string, exact = false): Promise<string> {
  const raw = (text ?? '').trim()
  if (!raw) return ''
  const to = exact ? targetLang : effectiveTargetLang(raw, targetLang)
  const key = `${'auto'}:${to}:${raw}`
  const hit = cache.get(key)
  if (hit !== undefined) { cache.delete(key); cache.set(key, hit); return hit }
  const [out] = await providers.edge.translate([raw], 'auto', to)
  if (cache.size >= LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(key, out)
  return out
}
```

`exact=true` 表示用户在弹窗下拉里显式选过目标语言，跳过同语种纠偏。

## 3. 【适配】UI 接入点（mydict-desktop）

### 3.1 快捷搜索窗（`src/ui-popup.ts`）

1. 提交入口（现有回车/查询处理处）：`const translate = isTranslateCandidate(input)`，把 `{ text, translate }` 存入历史栈（回退要还原线路）。
2. **语言标签行右侧追加「翻译」标签**：现有语言标签数据源是词典库（`dictionaries()`），翻译标签是固定伪标签（value 用 `'__translate__'`，不与语言码冲突）。
3. 选到翻译标签 → 渲染翻译视图（§3.3）；选词典语言标签 → 照旧渲染词条。
4. `←`/`→` 方向键的循环序列 = 现有语言标签 + 末尾的翻译标签（「全部」等重置类标签不参与循环）。**翻译标签激活时词典分组全部隐藏，反之亦然。**
5. 翻译请求**懒加载**：第一次切到翻译标签（或以翻译标签开场）才发；弹窗里的目标语言下拉用 `exact=true`。

### 3.2 划词优先路径（`selection_first` 设置）

拿到选区文本后同样过 `isTranslateCandidate`：像句子 → 直接打开翻译视图；像词 → 照旧查词典。

### 3.3 翻译视图（双窗格）

```
[译成 (目标语言下拉 ▾)]     ← 切换即重翻，弹窗不关闭
────────────────────────
原文（原文窗格，pre-wrap，字号略小、弱化色）
────────────────────────
译文（译文窗格；loading 态显示 spinner；失败显示原因 + 重试按钮）
```

- 样式跟现有暗色/亮色主题走（`theme.css` 的变量）。
- 失败文案分档：网络失败 / HTTP 非 200（带状态码）/ 超时，不要笼统「翻译失败」。

### 3.4 设置

- `Settings`（Rust 侧结构体 + `settings-modal.ts`）新增 `translate_target_lang`，默认 `"zh-Hans"`；设置弹窗给一个下拉（选项见下）。保存走现有 `save_settings`。

```
zh-Hans 简体中文 / zh-Hant 繁體中文 / en English / ja 日本語 / ko 한국어 /
fr Français / de Deutsch / es Español / ru Русский
```

## 4. 已知的坑（扩展实现里都真实发生过）

1. **词典查询慢不能挡译文**：MyDict 对长句的模糊前缀查询可能十几秒甚至超时。翻译模式下要**先把译文视图立起来**，词典结果回来再补渲染；查询失败用 toast 说明，绝不重渲染打断阅读译文。
2. **弹窗下拉是用户显式选择**：切语言必须 `exact=true` 绕过同语种纠偏，否则用户选「简体中文」翻中文文本会被偷偷改成英文。
3. **「全部」标签不参与 ←/→ 循环**（它只是点击用的重置位）；循环序列末尾是翻译标签。
4. **选区重复触发**：`selectionchange` 一次划选触发多次，用「起止容器+偏移」判重，选区未变不重置弹窗。
5. **重渲染会清掉译文状态**：词典结果补渲染时翻译标签保持激活；译文命中缓存秒回，但用户刚在下拉里改过的语言会被重置——补渲染尽量只发生在译文未加载完的窗口期。
6. **Edge 端点无官方文档**：UA 伪装（Edg/120）和 `isEnterpriseClient=false` 缺一不可；失败时给可重试错误态，provider 可插拔以便未来换正式服务。
7. **中日共用汉字**：目标语言必须可现场切换，zh→zh 自动纠偏成 en。

## 5. 验收标准

- [ ] 搜索框输入「政府」→ 词典；输入「今天天气非常好适合出门散步」→ 翻译标签激活且出译文
- [ ] 输入 "government" → 词典；输入 "the quick brown fox" → 翻译
- [ ] 词典结果页 ←/→ 能循环切到「翻译」并懒加载译文，再 ← 切回词典
- [ ] 翻译视图里切目标语言立即重翻；同一文本第二次秒出（缓存）
- [ ] `selection_first` 划句子直接出翻译，划单词照旧词典
- [ ] MyDict 服务不可达时译文照常工作（两者互不阻塞）
- [ ] 中→英、中→日、日→中、英→中 四条路径各验证一次
- [ ] `pnpm typecheck` 通过；设置持久化、重启生效
