# PROMPT：把「查词不命中自动切翻译（含手动出口）」+「在线词典」移植进 mydict-desktop

> 自包含规格：判定规则、API 请求/响应格式、可抄代码全部内嵌，无需访问扩展或 MyReader 源码。
> **前置**：基础划词翻译功能（线路判定 / Edge 翻译 / 翻译标签）按同目录
> `PROMPT_selection_translate_replication.md` 实现。本文件在其之上叠加两轮增量：
> ① 查词不命中（EMPTY）的自动/手动切翻译策略；② 「在线」词典标签。
> `【适配】`标记处按 mydict-desktop 实际代码调整。

---

## 特性一：查词不命中（EMPTY）的切翻译策略

### 1.1 判定函数（与翻译线路共用，可整段抄）

```ts
/** 是否为「翻译候选」：全非英文字母且长度≥6，或英文单词数≥3 */
export function isTranslateCandidate(text: string): boolean {
  const raw = (text ?? '').trim()
  if (raw.length < 6) return false
  if (!/[A-Za-z]/.test(raw)) return true
  const words = raw.split(/\s+/).filter((w) => /[A-Za-z]/.test(w))
  return words.length >= 3
}
```

### 1.2 行为矩阵（词典查询返回空时）

| 场景 | 行为 |
|---|---|
| 翻译模式（本来就走在翻译线）查询为空 | 视图不动，toast：`没有词典收录这段文字，看「翻译」标签即可` |
| 词典模式 + **是翻译候选**（≥6字/≥3词） | **自动**切到翻译视图（译文立即开始加载），toast：`没有词典收录「<词>」，已切换到翻译` |
| 词典模式 + **短词**（<6字） | **不自动切**。留在错误页：标题「没有词典收录这个词」+ 详情「也可以改走翻译线路。」+ 两个按钮：`重试`、`翻译`（手动点才切） |

设计理由：自动切换只对「明显是句子/长短语」的输入生效；短词查不到是常态（专名、生僻词），强行带去翻译会让人困惑「怎么 4 个字也翻译了」。手动按钮保留出口。

### 1.3 交互细节（真实踩过的坑）

1. **自动切换后要能切回词典线路**：翻译视图里词典线路必须保持可达——
   - 词典命中（哪怕是前缀匹配的单语言命中）→ 语言标签照常渲染。**只要有一个语言命中就要造该语言标签**（包括只有一个语言的情况，否则词典分组渲染了却不可达）；
   - 词典确实为空 → 加一个「词典」伪标签（value 如 `'__dict__'`），点过去显示「没有词典收录」的说明块。两条线路永远互达。
2. **重渲染不要打断读译文**：翻译模式下词典结果回来后补渲染时，「翻译」标签保持激活；译文命中缓存（见基础 prompt 的 §2.4）秒回。
3. toast 用现有通知通道，2~3 秒自动消失即可。

## 特性二：「在线」词典标签

数据来自 MyDict 服务端的聚合端点（服务端抓取 Wikipedia / Wiktionary / 百度百科 并纯文本化，带 600s 缓存与独立限流）。

### 2.1 API 规格（实测）

```
GET {server_url}/api/dict/online/lookup?word=<词>&lang=<2字母码>
无鉴权也可用（有 token 就带上 Bearer，与 /api/v1/query 一致）

响应 200:
{
  "word": "政府", "lang": "zh",
  "sections": [
    { "id": "wikipedia", "name": "Wikipedia", "title": "政府",
      "subtitle": "一個國家、區域的統治組織", "text": "政府 是一个政治体系…",
      "url": "https://zh.wikipedia.org/wiki/政府", "entries": null },
    { "id": "wiktionary", "name": "Wiktionary", "entries": [
        { "pos": "Noun", "language": "English",
          "senses": [ { "text": "…", "examples": ["…"] } ] } ] },
    { "id": "baike", "name": "百度百科", "title": "政府", "subtitle": "", "text": "…", "url": "…" }
  ],
  "links": [ { "id": "google", "name": "Google", "url": "https://…" }, … ]
}
```

- 字段都是可空的：`title/subtitle/text/url` 可能缺，`entries` 只有 Wiktionary 有，`links` 可能为空数组（取决于服务端 `online_dict_sources` 配置——**空是正常现象，不是 bug**）。
- `lang` 必须匹配 `^[a-z]{2}(-[A-Za-z]{2,4})?$`，传 2 字母码：`guessSourceLang(text).slice(0, 2)`（zh/ja/en/ko/ru…，基础 prompt 有该函数）。
- 服务端功能总开关 `online_dict_enabled` 关闭时返回 **403**——这不是鉴权问题，UI 要显示「在线词典未开启（MyDict 管理后台 → 系统设置）」，不要套用「Token 不对」的文案。
- `word` 服务端截断到 100 字符。

### 2.2 【适配】Tauri 通道

桌面端无 CORS 顾虑，走与 `search`/`translate` 相同的 Rust command 模式（src-tauri 新增，注册进 invoke_handler）：

```rust
#[tauri::command]
async fn online_lookup(server_url: String, token: Option<String>, word: String, lang: String)
    -> Result<serde_json::Value, String> {
    let url = format!("{}/api/dict/online/lookup?word={}&lang={}",
        server_url.trim_end_matches('/'),
        urlencoding::encode(&word), urlencoding::encode(&lang));
    let mut req = reqwest::Client::new()
        .get(&url)
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(15));
    if let Some(t) = token.as_deref() {
        if !t.is_empty() { req = req.header("Authorization", format!("Bearer {}", t)); }
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
```

（403 特判约定：错误串以 `UNSUPPORTED:` 前缀开头，前端据此显示「未开启」文案。）

### 2.3 UI 规格

- 语言标签行右侧追加「**在线**」伪标签（value `'__online__'`），位于「翻译」标签**左边**（翻译保持最右）。`←`/`→` 循环序列包含它。
- **懒加载**：第一次切到该标签才发请求；模块级 LRU 缓存（key = `${lang}:${text}`，上限 ~200），同一词反复切换不发请求。
- 内容为卡片列表，全部 `textContent` 注入（服务端已纯文本化，不渲染第三方 HTML）：

```
┌ 卡片 ──────────────────────────────┐
│ Wikipedia            [在新标签页打开 ↗] │  ← name + url 存在时给打开按钮
│ 政府                                  │  ← title（粗体）
│ 一個國家、區域的統治組織                │  ← subtitle（弱化色）
│ 政府 是一个政治体系，於某个區域…          │  ← text（pre-wrap）
└───────────────────────────────────┘
┌ Wiktionary ───────────────────────┐
│ Noun · English                       │  ← pos · language
│  • 释义文本                          │
│      例句（斜体、弱化）                 │  ← examples
└───────────────────────────────────┘
外部打开：[Google] [Urban] [Merriam-Webster] [Goodreads]   ← links 非空才渲染
```

- 「在新标签页打开」/外部链接：`【适配】`用 Tauri 的 shell 打开（`tauri-plugin-opener` 或现有 `open_external` command——api.ts 里已有）。
- 状态：loading（spinner + 「正在查询在线词典…」）、失败（错误原因 + 可重试）、服务未开启（`UNSUPPORTED` 专属文案）。
- 空结果（sections 与 links 都空）显示「在线词典没有返回内容」。

### 2.4 各查询入口都要带「在线」标签

- 搜索框查词、`selection_first` 划词、历史回退——凡是渲染词典结果的地方，「在线」标签一律存在（懒加载，不点不发请求）。
- 与翻译标签共存：语言标签 → 在线 → 翻译；`←`/`→` 依次循环。

## 已知的坑（扩展实现验证过的）

1. **EMPTY 自动切换只对翻译候选生效**——短词不命中别自动切（用户明确的口径），否则「4 个字也被翻译」的观感很差。
2. **单语言命中也要造语言标签**——否则词典分组渲染了却不可达，表象是「切不回词典」。
3. **服务端 `links` 可能为空**（取决于 `online_dict_sources` 配置），渲染代码要容忍空数组，不要当成异常。
4. **403 ≠ 鉴权失败**：这个端点上 403 的语义是「功能未开启」，错误分类要做映射，别让用户去检查 Token。
5. **重渲染保持激活标签**：补渲染词典分组时，当前激活的翻译/在线标签与已加载内容尽量不打断（缓存命中可瞬间恢复）。

## 验收标准

- [ ] 查询「你好世界」（4 字、词典 0 命中）→ 错误页 + 「翻译」按钮，不自动切；点按钮切到翻译视图
- [ ] 查询「今天天气非常好适合出门」（≥6 字、0 命中）→ 自动切翻译 + toast
- [ ] 翻译视图里词典线路可达：有命中时语言标签可切；无命中时「词典」伪标签显示未收录说明
- [ ] 「在线」标签懒加载：切过去才发请求；同一词二次切换秒出（缓存）
- [ ] 「政府」出 Wikipedia + 百度百科 卡片；"government" 出 Wiktionary 词性释义例句
- [ ] 服务端关闭 `online_dict_enabled` → 显示「未开启」文案（不是 Token 错误）
- [ ] 外部链接按钮能打开系统浏览器；`links` 为空时该行不渲染
- [ ] `pnpm typecheck` 通过；暗色主题下样式正常
