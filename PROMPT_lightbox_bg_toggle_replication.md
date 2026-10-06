# PROMPT：把「大图查看器背景色手动切换」移植进浏览器扩展（myreader-extension）

> 目标项目：**myreader-extension**（划词查词的 Chrome/Firefox MV3 扩展）
> 代码位置：`/vol1/1000/docker/myreader-extension/chrome/`（规范副本）与
> `/vol1/1000/docker/myreader-extension/firefox/`（同代码 + gecko manifest，**两处都要改**）。
> 本文自包含——算法、代码、样式、坑全部内嵌，不依赖读取 mydict-desktop 源码。

---

## 1. 背景与问题

扩展的「大图查看器」（幻灯片灯箱）默认铺一层**深色遮罩**，深色照片类图片没问题，但**扫描版词典整页图多半是白底/浅底**，深色背景下反衬不足、内容不好认。

桌面端（Tauri，mydict-desktop）已经解决这个问题：**默认浅色背景 + 右下角一键在深/浅之间切换**。本次把这套能力移植进扩展的灯箱。

**参考实现（桌面端 `src/ui-viewer.ts` 的核心，逐字内嵌）**：

```ts
const BG_LIGHT = '#f2f2f2'
const BG_DARK = '#0a0a0a'

let bgDark = false

const toggleBtn = document.createElement('button')
toggleBtn.type = 'button'
toggleBtn.className = 'viewer-bg-toggle'
document.body.appendChild(toggleBtn)

function applyBg(): void {
  document.body.style.background = bgDark ? BG_DARK : BG_LIGHT
  toggleBtn.textContent = bgDark ? '☀ 浅色背景' : '🌙 深色背景'
}
applyBg()

toggleBtn.addEventListener('click', () => {
  bgDark = !bgDark
  applyBg()
})

// …关键：桌面端 body 才是背景层，灯箱自带的深色遮罩会盖住它，必须抹掉
document.body.appendChild(lightbox.element)
lightbox.element.style.background = 'transparent'
```

**核心设计（务必保留）**：
- 默认 **浅色** `#f2f2f2`，深色 `#0a0a0a`（不是纯黑，纯黑更刺眼）。
- 右下角**常驻浮动按钮**，文案随状态变化：浅色态显示「🌙 深色背景」，深色态显示「☀ 浅色背景」（按钮文字提示的是「点下去会切到什么」）。
- 按钮用**半透明深色胶囊底**，在浅色和深色两种背景下都清晰可读。
- **背景色与「遮罩」互斥**：桌面端的难点是 body 背景被灯箱自己的深色遮罩挡住，所以要 `lightbox.element.style.background = 'transparent'`。

---

## 2. 扩展端为什么更简单——但有一个必须改的坑

扩展的灯箱（`render/lightbox.js`）与桌面端结构不同：

- 桌面端：`document.body` 是背景层，`.lightbox` 是叠在上面的深色遮罩 → 需要「透传」。
- 扩展端：**`.overlay` 本身就是那层全屏遮罩**（`background: rgba(10,14,12,0.86)`），它上面没有第二个背景层。

所以扩展端**不需要透明化技巧**——直接把 `.overlay` 的背景色作为切换目标即可：

- 浅色态：`.overlay { background: #f2f2f2 }`
- 深色态：`.overlay.dark { background: #0a0a0a }`

**必须一并修的坑（否则浅色态下按钮/提示看不见）**：当前 `.nav`（翻页）与 `.hint`（底部提示）用的是 `rgba(255,255,255,0.16)` 的**白色半透明**胶囊，那是为深色背景设计的；切到浅色背景后会「白字白底」近乎隐形。**改成半透明深色胶囊**（与桌面端同款），两种背景下都清晰：

```css
background: rgba(0, 0, 0, 0.45);
color: #f2f5f4;
```

---

## 3. 改动清单（唯一文件：`render/lightbox.js`，chrome/ 与 firefox/ 各一份）

无需改任何调用方（`render/images.js`、`popup.js` 的 `openImages`、`lightbox-page.js` 都只调 `openLightbox`/`isLightboxOpen`/`closeLightbox`，签名不变）。切换逻辑全部收在 `createInstance()` 内部。

### 3.1 改 `LIGHTBOX_CSS`

把现有的 `.overlay { … background: rgba(10, 14, 12, 0.86); … }` 段替换/补充为：

```css
.overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  overflow: hidden;
  /* 默认浅色：扫描版词典整页图多为白底，深色遮罩会淹没内容 */
  background: #f2f2f2;
  touch-action: none;
  cursor: grab;
}
.overlay.dark { background: #0a0a0a; }
.overlay.dragging { cursor: grabbing; }
```

`.nav` 与 `.hint` 的底色/前景改为（浅深两态都清晰）：

```css
.nav {
  /* …几何不变… */
  background: rgba(0, 0, 0, 0.45);
  color: #f2f5f4;
}
.nav:hover { background: rgba(0, 0, 0, 0.65); }

.hint {
  /* …几何不变… */
  background: rgba(0, 0, 0, 0.5);
  color: #f2f5f4;
}
```

新增右下角切换按钮样式（**注意 `bottom` 要比 hint 高一点**：hint 固定在 `bottom:16px` 居中，按钮同高但靠右，不冲突；如需更稳可把按钮放 `bottom:56px`）：

```css
.bg-toggle {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 2;
  padding: 4px 12px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.45);
  color: #f2f5f4;
  font: 12px/1.6 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  cursor: pointer;
}
.bg-toggle:hover { background: rgba(0, 0, 0, 0.65); }
```

### 3.2 改 `createInstance()`：造按钮 + 切换逻辑 + 接线

在现有 `const hint = …` 之后、`shadow.append(style, overlay)` 之前插入按钮创建，并把按钮 append 进 **overlay**（不是 shadow 直接子节点，保证随遮罩一起隐藏）：

```js
const bgBtn = document.createElement('button')
bgBtn.type = 'button'
bgBtn.className = 'bg-toggle'
overlay.appendChild(bgBtn)
```

在 `createInstance()` 的状态区加：

```js
const BG_LIGHT = '#f2f2f2'
const BG_DARK = '#0a0a0a'
let bgDark = false // 默认浅色（与桌面端一致）
```

在 `open()` 之前定义切换函数：

```js
function applyBg() {
  overlay.classList.toggle('dark', bgDark)
  bgBtn.textContent = bgDark ? '☀ 浅色背景' : '🌙 深色背景'
}
applyBg()
```

在现有事件接线段（`overlay.addEventListener('click', onOverlayClick)` 附近）加按钮监听：

```js
// 按钮上的按下/点击都不能冒泡到遮罩：否则会被当成「点空白」或开启拖动
bgBtn.addEventListener('pointerdown', (event) => event.stopPropagation())
bgBtn.addEventListener('click', (event) => {
  event.stopPropagation()
  bgDark = !bgDark
  applyBg()
})
```

**为什么必须 `stopPropagation`**：
- `onPointerDown` 只在 `event.target === overlay || event.target === img` 时才开拖——按钮天然不会开拖，但 `stopPropagation` 是双保险；
- `onOverlayClick` 只在 `event.target === overlay` 时关闭——按钮不是 overlay，本不会误关，但显式拦截更稳（尤其 `pointerdown` 被其它逻辑扩展时）。

### 3.3（可选增强）记住用户偏好

桌面端不持久化。扩展里如需跨会话记住，用 `chrome.storage.local`（content script 在授权下有该 API）：

```js
// 初始化时读取
chrome.storage?.local?.get?.('lightboxBgDark', (v) => {
  if (v && typeof v.lightboxBgDark === 'boolean') {
    bgDark = v.lightboxBgDark
    applyBg()
  }
})
// 切换时写入
chrome.storage?.local?.set?.({ lightboxBgDark: bgDark })
```

> 不做持久化也完全满足本次需求，与桌面端行为一致；按需取舍。

---

## 4. 必须遵守的既有约束（扩展灯箱特有）

1. **样式写在 shadow 内的 `LIGHTBOX_CSS`**：灯箱是 shadow DOM，页面 CSS 进不来；同理新按钮样式也必须写在这段 CSS 里，不能写进全局样式表。
2. **宿主免疫内联样式不用动**：`immuneStyles(host)` 只作用于宿主 `div`（负责 `position:fixed`、`z-index`、`background:transparent` 等）；按钮在 shadow 内部，不受页面广告拦截样式表干扰，无需额外处理。
3. **`background` 用不透明纯色**：桌面端浅色是 `#f2f2f2`、深色 `#0a0a0a`；不要沿用原来的 `rgba(…,0.86)` 半透明（浅色态会透出页面内容、显得脏）。
4. **按钮层级**：`z-index: 2` 高于图片（图片无 z-index，在文档流靠前）即可，勿超过遮罩本身（遮罩 `2147483647`）。
5. **Esc / ←/→ 行为不变**：切换按钮不注册任何键盘处理，不影响 `onKeydown` 在 window 捕获阶段拦截 Esc、←/→。
6. **独立标签页路径同样生效**：`lightbox.html` → `lightbox-page.js` → 同一个 `openLightbox`，因此 popup 里「点大图开独立标签」的页面自动获得该能力（按钮照常可用，关闭仍走 `window.close()`）。

---

## 5. 验收标准

在扩展的网页内面板和独立 `lightbox.html` 页都逐条验证：

1. 打开任一扫描图词条的大图 → 灯箱**默认浅色**背景（`#f2f2f2`），不再是深色。
2. 右下角有按钮「🌙 深色背景」；点击后背景变 `#0a0a0a`，按钮文案变「☀ 浅色背景」；再点切回浅色。
3. 连点切换按钮**不会关闭灯箱**，也不会触发拖动。
4. 浅色与深色两种背景下，**翻页按钮（‹ ›）与底部提示文字都清晰可读**（深色胶囊底，不是白字白底）。
5. 点击图片以外空白 / 按 Esc 仍能正常关闭；←/→ 翻页、滚轮缩放、拖动平移不受影响。
6. `chrome/` 与 `firefox/` 两处 `render/lightbox.js` 改动一致，两端行为相同。
7. 改动后按扩展既有调试法重测：MV3 unpacked 改 JS 后**必须 `chrome.runtime.reload()`**（仅重启浏览器不够，SW 模块实例会陈旧），并**刷新页面**（reload 后旧页面 content script 会孤儿化）。**禁止把扩展 ID / 路径 / 截图当作验收依据——以真机交互实测为准。**

---

## 6. 交付物

- 修改后的 `chrome/render/lightbox.js` 与 `firefox/render/lightbox.js`（仅此一文件，逻辑同上）。
- 若有发版：按既有流程 bump manifest version（同一 version 不可重复签名），并同步 `chrome/` ↔ 仓库。
