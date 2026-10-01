# mydict-desktop

[MyDict](https://github.com/PoxenStudio/mydict) 的桌面查词器：**全局热键呼出搜索框，查词结果直接复用 MyDict 的词条渲染**。



## 截图
<img width="1493" height="850" alt="image" src="https://github.com/user-attachments/assets/38ac5e93-e359-4417-8b10-fa8121934202" />
<img width="1247" height="868" alt="image" src="https://github.com/user-attachments/assets/45d4e5e9-db00-43ab-aefc-333e604e7cff" />




## 它做什么

- 全局热键呼出一个无边框悬浮窗（默认 `super+shift+d`，可在设置里改）
  —— 默认值挑得小心：`Win+F` 是 Windows 反馈中心、`Alt+Space` 是 XFCE 窗口菜单、`Ctrl+Alt+F` 是 Linux 切换虚拟控制台，都会被系统抢走；注册失败时设置页会直接告诉你
- 输入词语 → 列出 MyDict 里命中的词典与词条 → 点开即看
- 词条区的排版、图片、发音、词条内 `entry://` 跳转、选中文字查词**全部沿用 MyDict 的词条文档**——本项目不重写渲染层

## 它怎么复用 MyDict 的渲染（关键设计）

两件事，见 `src/entry-frame.ts`：

1. 用登录令牌取回词条 HTML（`GET /api/dict/entry/{dictionary_id}?word=…&entry_ids=…`）
2. 往 `<head>` 注入一行 `<base href="<服务器地址>/">` 后塞进 `<iframe sandbox="allow-scripts" srcdoc="…">`

为什么要注入 `<base>`：词条文档里的资源是**根相对**的（`/dict-res/<id>/res/…`），而 `srcdoc` 文档的源是本应用的 `tauri://localhost`，不注入就会全部 404。资源接口本身是公开只读且带 `Access-Control-Allow-Origin: *`，所以沙箱 iframe（不透明源）里也能加载。

## 身份

用 **MyDict 用户账号登录**（`/api/auth/login` 换 JWT）：可用词典跟随账号、查询进历史，与网页版同一套权限。access 令牌过期时用 refresh 静默续期。

## 配置与数据

配置与令牌存放在本机应用配置目录的 `config.json`（Linux: `~/.config/com.toyqiu.mydict.desktop/`；Windows: `%APPDATA%`）。

> **令牌是明文存储**：这是自用桌面工具的取舍（不引入系统钥匙串依赖）。介意的话把它当普通凭据对待，不要在共享机器上使用。

## 构建

前置：Node 20+、Rust 稳定版、[Tauri 的系统依赖](https://tauri.app/start/prerequisites/)（Linux 需要 `libwebkit2gtk-4.1-dev` 等）。

```bash
pnpm install
pnpm tauri dev          # 开发（热重载）
pnpm tauri build        # 出安装包（Linux: deb/AppImage）
```

调试提示：`pnpm tauri dev -- -- --show` 可以让窗口启动即显示（默认是隐藏的，等热键呼出）。若热键被别占用，设置页会明确报出「注册失败」。

## 与 MyDict 的版本关系

本客户端**不改 MyDict 任何代码**，只依赖两个公开接口的行为：

| 用途 | 接口 |
|---|---|
| 登录 / 续期 | `POST /api/auth/login` · `POST /api/auth/refresh` |
| 搜索（不含释义） | `GET /api/dict/search?word=…` |
| 词条文档（自包含 HTML） | `GET /api/dict/entry/{dictionary_id}?word=…&entry_ids=…` |

## License

MIT
