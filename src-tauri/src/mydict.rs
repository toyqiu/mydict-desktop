//! MyDict 的 HTTP 客户端、会话与配置。
//!
//! 走的是**前台 web 接口**（`/api/auth/login`、`/api/dict/search`、`/api/dict/entry/{id}`）——
//! 它们认用户 JWT，和网页版同一套，因此能直接拿到词条富文本 HTML（`/api/v1/*` 是 Token
//! 口径，不是我们要的身份）。
//!
//! 配置与令牌落盘到 `app_config_dir/config.json`：桌面自用工具，明文存储（README 里写明）。
//! access 过期时用 refresh 静默换一次再重试，用户无感。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::DEFAULT_HOTKEY;

/// 与前端交换的搜索命中：对应服务端 `WebQueryResultItem` 里我们用得上的字段
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hit {
    pub id: i64,
    pub dictionary_id: i64,
    pub dictionary_name: String,
    pub word: String,
    #[serde(default)]
    pub phonetic: Option<String>,
    /// 命中词典的源语言（zh-Hans/ja/…）：前端用它做「按语种分组」的标签行。
    /// 服务端一直返回这个字段，这里不声明的话 serde 会直接丢掉——实测弹窗的语言标签
    /// 因此只剩一个「other」组。
    #[serde(default)]
    pub lang_from: Option<String>,
    /// 该词典的语言方向是否与输入一致；false 表示这是「优先语言没命中、退到其它语言」的结果
    #[serde(default)]
    pub lang_match: bool,
}

#[derive(Debug, Deserialize)]
struct WebQueryResponse {
    results: Vec<Hit>,
}

/// `/api/dict/dictionaries` 的条目：词典列表（语言标签行的数据源）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicDict {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub lang_from: String,
    #[serde(default)]
    pub lang_to: String,
}

/// 服务端 `TokenPairResponse`
#[derive(Debug, Deserialize)]
struct TokenPair {
    access_token: String,
    refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub server_url: String,
    pub username: String,
    pub hotkey: String,
    /// 界面主题：dark（默认，悬浮窗形态）| light（与 cal 默认皮肤一致）
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 失焦即收起。X11 上要等 Rust 侧发出「已显示」事件后才生效（见 main.rs）
    #[serde(default = "default_true")]
    pub hide_on_blur: bool,
    /// 划词优先：热键呼出时若系统里有选中文字，直接查它并以「不抢焦点」的方式展示
    #[serde(default = "default_true")]
    pub selection_first: bool,
    /// 剪贴板监听：复制文字（≤60 字）自动弹窗查词
    #[serde(default = "default_true")]
    pub clipboard_watch: bool,
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            username: String::new(),
            hotkey: DEFAULT_HOTKEY.to_string(),
            theme: default_theme(),
            hide_on_blur: true,
            selection_first: true,
            clipboard_watch: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Tokens {
    #[serde(default)]
    pub access: String,
    #[serde(default)]
    pub refresh: String,
    #[serde(default)]
    pub username: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Persisted {
    #[serde(default)]
    settings: Settings,
    #[serde(default)]
    tokens: Tokens,
}

/// 前端要的状态快照
#[derive(Debug, Serialize)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub username: String,
    pub server_url: String,
}

pub struct AppState {
    pub client: reqwest::Client,
    dir: PathBuf,
    inner: Mutex<Inner>,
    /// 窗口当前是否可见。
    ///
    /// **不能用 `Window::is_visible()`**：X11/GTK 下它对这种无边框窗口恒为 false（实测：
    /// `show()` 之后依然 false），于是「再按一次热键收起」永远走不到收起分支。这里自己记账，
    /// 由热键切换、Esc 收起、失焦收起三处共同维护。
    window_visible: AtomicBool,
}

struct Inner {
    settings: Settings,
    tokens: Tokens,
    /// 热键注册失败的原因（占用了/写错了），前端设置页要能看到，不能静默失败
    hotkey_error: Option<String>,
}

impl AppState {
    pub fn load(dir: PathBuf) -> Self {
        let persisted: Persisted = std::fs::read_to_string(dir.join("config.json"))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("构建 HTTP 客户端失败"),
            dir,
            window_visible: AtomicBool::new(false),
            inner: Mutex::new(Inner {
                settings: persisted.settings,
                tokens: persisted.tokens,
                hotkey_error: None,
            }),
        }
    }

    fn save(&self) {
        let inner = self.inner.lock().expect("state poisoned");
        let persisted = Persisted {
            settings: inner.settings.clone(),
            tokens: inner.tokens.clone(),
        };
        drop(inner);
        if let Ok(raw) = serde_json::to_string_pretty(&persisted) {
            let _ = std::fs::write(self.dir.join("config.json"), raw);
        }
    }

    pub fn is_window_visible(&self) -> bool {
        self.window_visible.load(Ordering::Relaxed)
    }

    pub fn set_window_visible(&self, value: bool) {
        self.window_visible.store(value, Ordering::Relaxed);
    }

    pub fn settings(&self) -> Settings {
        self.inner.lock().expect("state poisoned").settings.clone()
    }

    pub fn set_settings(&self, patch: Settings) {
        self.inner.lock().expect("state poisoned").settings = patch;
        self.save();
    }

    pub fn auth_status(&self) -> AuthStatus {
        let inner = self.inner.lock().expect("state poisoned");
        AuthStatus {
            logged_in: !inner.tokens.access.is_empty(),
            username: inner.tokens.username.clone(),
            server_url: inner.settings.server_url.clone(),
        }
    }

    pub fn set_hotkey_error(&self, message: Option<String>) {
        self.inner.lock().expect("state poisoned").hotkey_error = message;
    }

    pub fn hotkey_error(&self) -> Option<String> {
        self.inner.lock().expect("state poisoned").hotkey_error.clone()
    }

    pub fn logout(&self) {
        {
            let mut inner = self.inner.lock().expect("state poisoned");
            inner.tokens = Tokens::default();
        }
        self.save();
    }

    /// 服务器地址：去掉尾部斜杠；未配置时报错给用户看
    pub fn base(&self) -> Result<String, String> {
        let raw = self.settings().server_url;
        let trimmed = raw.trim().trim_end_matches('/').to_string();
        if trimmed.is_empty() {
            return Err("还没配置 MyDict 服务器地址".into());
        }
        if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
            return Err("服务器地址要以 http:// 或 https:// 开头".into());
        }
        Ok(trimmed)
    }

    fn token(&self) -> String {
        self.inner.lock().expect("state poisoned").tokens.access.clone()
    }

    fn store_tokens(&self, pair: TokenPair, username: &str) {
        {
            let mut inner = self.inner.lock().expect("state poisoned");
            inner.tokens = Tokens {
                access: pair.access_token,
                refresh: pair.refresh_token,
                username: username.to_string(),
            };
            inner.settings.username = username.to_string();
        }
        self.save();
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<(), String> {
        let base = self.base()?;
        let response = self
            .client
            .post(format!("{base}/api/auth/login"))
            .json(&serde_json::json!({ "username": username, "password": password }))
            .send()
            .await
            .map_err(|e| format!("连不上 {base}：{e}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(match status.as_u16() {
                401 => "用户名或密码错误".to_string(),
                403 => "账号被禁用，或服务端未开放登录".to_string(),
                _ => format!("登录失败（HTTP {status}）：{}", body.chars().take(200).collect::<String>()),
            });
        }
        let pair: TokenPair = response
            .json()
            .await
            .map_err(|e| format!("登录响应解析失败：{e}"))?;
        self.store_tokens(pair, username);
        Ok(())
    }

    /// 用 refresh 换新的 access；失败就把令牌清掉（让 UI 退回登录态）
    pub async fn refresh(&self) -> Result<String, String> {
        let base = self.base()?;
        let refresh_token = self.inner.lock().expect("state poisoned").tokens.refresh.clone();
        if refresh_token.is_empty() {
            return Err("尚未登录".into());
        }
        let response = self
            .client
            .post(format!("{base}/api/auth/refresh"))
            .json(&serde_json::json!({ "refresh_token": refresh_token }))
            .send()
            .await
            .map_err(|e| format!("刷新登录态失败：{e}"))?;
        if !response.status().is_success() {
            self.logout();
            return Err("登录已过期，请重新登录".into());
        }
        let pair: TokenPair = response
            .json()
            .await
            .map_err(|e| format!("刷新响应解析失败：{e}"))?;
        let username = self.inner.lock().expect("state poisoned").tokens.username.clone();
        self.store_tokens(pair, &username);
        Ok(self.token())
    }

    async fn access_or_refresh(&self) -> Result<String, String> {
        let current = self.token();
        if !current.is_empty() {
            return Ok(current);
        }
        self.refresh().await
    }

    /// 带鉴权的 GET；遇 401 自动刷新一次再重试
    async fn get_authed(&self, path_and_query: &str) -> Result<reqwest::Response, String> {
        let base = self.base()?;
        let url = format!("{base}{path_and_query}");
        let mut token = self.access_or_refresh().await?;
        for attempt in 0..2 {
            let response = self
                .client
                .get(&url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| friendly_request_error(&url, &e))?;
            if response.status().as_u16() == 401 && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            return Ok(response);
        }
        unreachable!("循环里必然已 return")
    }

    async fn parse_or_error<T: for<'de> Deserialize<'de>>(
        response: reqwest::Response,
    ) -> Result<T, String> {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!(
                "服务端返回 HTTP {status}：{}",
                body.chars().take(200).collect::<String>()
            ));
        }
        serde_json::from_str(&body).map_err(|e| format!("响应解析失败：{e}"))
    }

    /// 词典列表（scope=usable 当前用户可用的启用词典）。
    /// 语言标签行的数据源来自**词典库**而不是命中结果——网页版的标签就是检索范围选择器，
    /// 库里有哪几种语言就显示哪几项，与这一次查询命中了什么无关。
    pub async fn dictionaries(&self, scope: &str) -> Result<Vec<PublicDict>, String> {
        let response = self
            .get_authed(&format!(
                "/api/dict/dictionaries?scope={}",
                urlencode(scope)
            ))
            .await?;
        Self::parse_or_error(response).await
    }

    pub async fn search(&self, word: &str, dict_ids: Option<&[i64]>) -> Result<Vec<Hit>, String> {
        let mut path = format!("/api/dict/search?word={}", urlencode(word));
        if let Some(ids) = dict_ids {
            if !ids.is_empty() {
                // 检索范围（语言标签选择）：与网页版侧边栏勾选同一参数
                let joined = ids
                    .iter()
                    .map(|id| id.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                path.push_str(&format!("&dict={}", urlencode(&joined)));
            }
        }
        let response = self.get_authed(&path).await?;
        let parsed: WebQueryResponse = Self::parse_or_error(response).await?;
        Ok(parsed.results)
    }

    /// 词条文档 HTML（自包含：词典样式 + 注入的引导脚本）
    pub async fn entry_html(
        &self,
        dictionary_id: i64,
        word: &str,
        entry_ids: &[i64],
    ) -> Result<String, String> {
        let ids = entry_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let mut path = format!(
            "/api/dict/entry/{dictionary_id}?word={}",
            urlencode(word)
        );
        if !ids.is_empty() {
            path.push_str(&format!("&entry_ids={ids}"));
        }
        let response = self.get_authed(&path).await?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("读取词条内容失败：{e}"))?;
        if !status.is_success() {
            return Err(format!(
                "取词条失败（HTTP {status}）：{}",
                body.chars().take(200).collect::<String>()
            ));
        }
        Ok(body)
    }
}

/// 把 reqwest 的错误翻成人话：用户看到「连不上」比看到 `error sending request for url` 有用。
fn friendly_request_error(url: &str, error: &reqwest::Error) -> String {
    let host = url.split("//").nth(1).and_then(|rest| rest.split('/').next()).unwrap_or(url);
    if error.is_timeout() {
        format!("连接 {host} 超时：服务器没响应（地址对吗？服务在运行吗？）")
    } else if error.is_connect() {
        format!("连不上 {host}：请检查服务器地址、端口，以及本机是否能访问到它")
    } else {
        format!("请求 {url} 失败：{error}")
    }
}

/// 只转义查询值里必须转义的字符；中文/日文交给 reqwest 自己处理前先 encode 更稳
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 3);
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}
